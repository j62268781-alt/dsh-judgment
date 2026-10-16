/**
 * TypeSafe **SystemOne**（协议里的 `noul`）线格式：编码 + 严格解码。
 *
 * 线格式不是猜的，是 P0′ 探针实测确定的（`tests/protocol.test.mjs` 里的固件就是
 * 真实端点回的原样 JSON）：
 *
 * ```jsonc
 * // 请求：POST <baseUrl>，Authorization: Bearer <key>
 * { "model": "decision-model-preview", "state": <Json>,
 *   "questions": { "<id>": { "type": "noul", "instructions": "...", "criteria": {"true": "…", "false": "…"} },
 *                  "<id>": { "type": "choice", "instructions": "...", "criteria": { "<optionId>": "说明" } },
 *                  "<id>": { "type": "score", "instructions": "...", "criteria": ["很小", "一般", "很大"] } } }
 *
 * // 响应：
 * { "model": "decision-model-preview",
 *   "answers": { "<id>": { "type": "noul", "noul": 0.98 },
 *                "<id>": { "type": "choice", "choice": "a2", "confidence": 0.18, "probabilities": {"a0":0.35,"a1":0.19,"a2":0.46} },
 *                "<id>": { "type": "score", "score": 0.84, "legend": {"0":"很小","1":"一般","2":"很大"},
 *                          "probabilities": {"0":0.45,"1":0.26,"2":0.29}, "confidence": 0.58 } },
 *   "usage": { "input_tokens": 99, "output_tokens": 0 }, "request_id": "…", "latency_ms": 53.2 }
 * ```
 *
 * 实测要点（写进契约的三条校准）：
 * - `score` 是**连续位置**（= 级别分布的期望值 `Σ i·p_i`，实测 0.84 / 1.42 / 1.09），不是整数下标；
 * - `noul` 不带 `confidence`，`confidence`/`legend` 都**绝不合成**（协议没给就留空）；
 * - `state` 可以是纯字符串，不限于对象。
 *
 * 解码**失败即拒**：结构非法一律抛 {@link ResponseRejected}（整批拒绝，不修复），
 * 而"结构合法地没有判断"（`null` 答案 / `type:'refusal'`）是 `abstain` **值**，不是异常。
 */

import type {
  ChoiceAnswer,
  JudgmentAnswer,
  JudgmentQuestion,
  JudgmentQuestions,
  JudgmentState,
  NoulAnswer,
  NormalizedDistribution,
  ScoreAnswer,
} from '../contract/index.js'
import {
  ARGMAX_TOLERANCE,
  NORMALIZATION_TOLERANCE,
  ResponseRejected,
  decodeModel,
  decodeSignals,
  decodeUsage,
  isProbability,
  isRecord,
  knownUsage,
  reject,
  validateDistribution,
  type DecodedResponse,
  type DecodedUsage,
} from './wire.js'

export { ARGMAX_TOLERANCE, NORMALIZATION_TOLERANCE, ResponseRejected, knownUsage }
export type { DecodedResponse, DecodedUsage }

/* ─────────────────────────────── 编码 ─────────────────────────────── */

/** 一批问题 → SystemOne 请求体。 */
export function encodeBody(
  model: string,
  state: JudgmentState,
  questions: JudgmentQuestions,
): Record<string, unknown> {
  return {
    model,
    state,
    questions: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [id, encodeQuestion(question)]),
    ),
  }
}

function encodeQuestion(question: JudgmentQuestion): Record<string, unknown> {
  if (question.kind === 'choice') {
    return { type: 'choice', instructions: question.prompt, criteria: { ...question.options } }
  }
  if (question.kind === 'score') {
    return { type: 'score', instructions: question.prompt, criteria: [...question.levels] }
  }
  return {
    type: 'noul',
    instructions: question.prompt,
    // criteria 省略时整个字段不发（上游对 `criteria.true/false` 两侧缺失有自己的处理）。
    ...(question.criteria === undefined ? {} : { criteria: { ...question.criteria } }),
  }
}

/* ─────────────────────────────── 解码 ─────────────────────────────── */

/** 严格解码一整批答案：任何结构问题都整批拒绝。 */
export function decodeResponse(
  raw: unknown,
  questions: JudgmentQuestions,
  expectedModel: string,
): DecodedResponse {
  if (!isRecord(raw)) reject('answer-set-equality', '响应不是 JSON 对象')
  const body = raw as Record<string, unknown>
  const answersRaw = body.answers
  if (!isRecord(answersRaw)) reject('answer-set-equality', '响应里没有 answers 对象')

  const expected = Object.keys(questions)
  const got = Object.keys(answersRaw)
  if (got.length !== expected.length) {
    reject('answer-set-equality', `答案数 ${got.length} 与问题数 ${expected.length} 不一致`)
  }
  for (const id of expected) {
    if (!Object.hasOwn(answersRaw, id)) reject('answer-set-equality', `问题 "${id}" 没有答案`, id)
  }
  for (const id of got) {
    if (!Object.hasOwn(questions, id)) reject('answer-set-equality', `多出一个未提问的答案 "${id}"`, id)
  }

  const answers: Record<string, JudgmentAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    answers[id] = decodeAnswer(answersRaw[id], question, id)
  }

  const usage = decodeUsage(body.usage)
  return {
    answers,
    model: decodeModel(body.model, expectedModel),
    ...(usage === undefined ? {} : { usage }),
    ...(typeof body.request_id === 'string' ? { requestId: body.request_id } : {}),
  }
}

function decodeAnswer(value: unknown, question: JudgmentQuestion, id: string): JudgmentAnswer {
  // 结构合法地"没有判断"：显式 null，或协议层拒答 → 值（abstain），不是异常。
  if (value === null) return { kind: 'abstain', reason: 'no-answer' }
  if (!isRecord(value)) reject('answer-shape', `答案 "${id}" 不是对象`, id)

  if (value.type === 'refusal' || value.refusal !== undefined) {
    return { kind: 'abstain', reason: 'refusal' }
  }
  if (value.type !== undefined && value.type !== question.kind) {
    reject('answer-shape', `答案 "${id}" 的类型 ${String(value.type)} 与问题原语 ${question.kind} 不一致`, id)
  }

  const signals = decodeSignals(value, id)
  if (question.kind === 'noul') {
    if (!isProbability(value.noul)) {
      reject('answer-shape', `noul "${id}" 的概率缺失或不在 [0,1]`, id)
    }
    return { kind: 'noul', probability: value.noul, ...signals } satisfies NoulAnswer
  }

  if (question.kind === 'choice') {
    const optionIds = Object.keys(question.options)
    if (typeof value.choice !== 'string' || !optionIds.includes(value.choice)) {
      reject('answer-shape', `choice "${id}" 选中的候选不在候选集合里`, id)
    }
    const probabilities = validateDistribution(
      objectDistribution(value.probabilities, id), optionIds, id, value.choice,
    )
    return {
      kind: 'choice',
      optionId: value.choice,
      probabilities: probabilities as NormalizedDistribution<string>,
      ...signals,
    } satisfies ChoiceAnswer
  }

  const levelKeys = question.levels.map((_, index) => String(index))
  const score = value.score
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > question.levels.length - 1) {
    reject('answer-shape', `score "${id}" 的位置越出级别范围 [0,${question.levels.length - 1}]`, id)
  }
  const probabilities = validateDistribution(objectDistribution(value.probabilities, id), levelKeys, id)
  return {
    kind: 'score',
    // 实测：这是级别分布的期望值，可以是小数（0.84 而非整数下标）。**不取整**。
    value: score,
    probabilities: probabilities as NormalizedDistribution<`${number}`>,
    ...signals,
  } satisfies ScoreAnswer
}

/** SystemOne 用**对象**装分布：`{ "<optionId>": p }`。 */
function objectDistribution(value: unknown, id: string): Map<string, unknown> {
  if (!isRecord(value)) reject('distribution-complete', `答案 "${id}" 没有完整概率分布`, id)
  return new Map(Object.entries(value))
}
