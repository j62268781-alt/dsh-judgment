/**
 * TypeSafe **SystemOne**（协议里的 `noul`）线格式：编码 + 严格解码。
 *
 * 线格式不是猜的，是 2026 P0′ 探针实测确定的（`tests/protocol.test.mjs` 里的固件就是
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
 * - `score` 是**连续位置**（= 级别分布的期望值 `Σ i·p_i`，实测 0.84 / 1.42），不是整数下标；
 * - `noul` 不带 `confidence`，`confidence`/`legend` 都**绝不合成**（协议没给就留空）；
 * - `state` 可以是纯字符串，不限于对象。
 *
 * 解码**失败即拒**：结构非法一律抛 {@link ResponseRejected}（整批拒绝，不修复），
 * 而"结构合法地没有判断"（`null` 答案 / `type:'refusal'`）是 `abstain` **值**，不是异常。
 */

import type {
  ChoiceAnswer,
  JudgmentAnswer,
  JudgmentJson,
  JudgmentQuestion,
  JudgmentQuestions,
  JudgmentState,
  NoulAnswer,
  NormalizedDistribution,
  Probability,
  ScoreAnswer,
  ValidationFailure,
  ValidationRule,
} from '../contract/index.js'
import { isJson } from './request.js'

/** 容差定稿：`|Σp − 1|` 与 argmax 容差（契约 `ValidationTolerance` 的运行期对应物）。 */
export const NORMALIZATION_TOLERANCE = 0.02
export const ARGMAX_TOLERANCE = 0.000001

/** 严格校验失败。Service 把它转成 `invalid-response`（整批拒绝，不修复）。 */
export class ResponseRejected extends Error {
  override readonly name = 'ResponseRejected'
  constructor(readonly validation: ValidationFailure) {
    super(validation.detail)
  }
}

export interface DecodedUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface DecodedResponse {
  readonly answers: Record<string, JudgmentAnswer>
  /** 响应返回的模型快照（不是配置里的别名）。 */
  readonly model: string
  readonly usage?: DecodedUsage
  /** 上游的请求 id，供审计 ledger 对齐。 */
  readonly requestId?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function probability(value: unknown): value is Probability {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function reject(rule: ValidationRule, detail: string, questionId?: string): never {
  throw new ResponseRejected({ rule, detail, ...(questionId === undefined ? {} : { questionId }) })
}

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
  if (!record(raw)) reject('answer-set-equality', '响应不是 JSON 对象')
  const body = raw as Record<string, unknown>
  const answersRaw = body.answers
  if (!record(answersRaw)) reject('answer-set-equality', '响应里没有 answers 对象')

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

function decodeModel(value: unknown, expected: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    reject('model-name', '响应没有返回模型快照——无法确认这次判断是谁做的')
  }
  // 移动别名（`…-latest`）本来就指到具体版本上，允许快照不同；其它情况必须逐字相同，
  // 否则就是"悄悄换了模型"（§13.4 要求 pin 并记录快照）。
  if (value !== expected && !/latest/i.test(expected)) {
    reject('model-name', `响应模型快照 "${value}" 与配置的 "${expected}" 不一致`)
  }
  return value
}

function decodeAnswer(value: unknown, question: JudgmentQuestion, id: string): JudgmentAnswer {
  // 结构合法地"没有判断"：显式 null，或协议层拒答 → 值（abstain），不是异常。
  if (value === null) return { kind: 'abstain', reason: 'no-answer' }
  if (!record(value)) reject('answer-shape', `答案 "${id}" 不是对象`, id)
  const answer = value as Record<string, unknown>

  if (answer.type === 'refusal' || answer.refusal !== undefined) {
    return { kind: 'abstain', reason: 'refusal' }
  }
  if (answer.type !== undefined && answer.type !== question.kind) {
    reject('answer-shape', `答案 "${id}" 的类型 ${String(answer.type)} 与问题原语 ${question.kind} 不一致`, id)
  }

  const signals = decodeSignals(answer, id)
  if (question.kind === 'noul') {
    if (!probability(answer.noul)) {
      reject('answer-shape', `noul "${id}" 的概率缺失或不在 [0,1]`, id)
    }
    return { kind: 'noul', probability: answer.noul, ...signals } satisfies NoulAnswer
  }

  if (question.kind === 'choice') {
    const optionIds = Object.keys(question.options)
    if (typeof answer.choice !== 'string' || !optionIds.includes(answer.choice)) {
      reject('answer-shape', `choice "${id}" 选中的候选不在候选集合里`, id)
    }
    const probabilities = decodeDistribution(answer.probabilities, optionIds, id, answer.choice)
    return {
      kind: 'choice',
      optionId: answer.choice,
      probabilities: probabilities as NormalizedDistribution<string>,
      ...signals,
    } satisfies ChoiceAnswer
  }

  const levelKeys = question.levels.map((_, index) => String(index))
  const score = answer.score
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > question.levels.length - 1) {
    reject('answer-shape', `score "${id}" 的位置越出级别范围 [0,${question.levels.length - 1}]`, id)
  }
  const probabilities = decodeDistribution(answer.probabilities, levelKeys, id)
  return {
    kind: 'score',
    // 实测：这是级别分布的期望值，可以是小数（0.84 而非整数下标）。**不取整**。
    value: score,
    probabilities: probabilities as NormalizedDistribution<`${number}`>,
    ...signals,
  } satisfies ScoreAnswer
}

/** `confidence` / `legend` 原样透传；协议没给就**绝不合成**（§13.2 铁律）。 */
function decodeSignals(answer: Record<string, unknown>, id: string): { confidence?: Probability; legend?: JudgmentJson } {
  const signals: { confidence?: Probability; legend?: JudgmentJson } = {}
  if (answer.confidence !== undefined) {
    if (!probability(answer.confidence)) reject('answer-shape', `答案 "${id}" 的 confidence 不在 [0,1]`, id)
    signals.confidence = answer.confidence
  }
  if (answer.legend !== undefined) {
    if (!isJson(answer.legend)) reject('answer-shape', `答案 "${id}" 的 legend 不是可 JSON 序列化的值`, id)
    signals.legend = answer.legend as JudgmentJson
  }
  return signals
}

/** 分布：键集合必须与候选/级别完全一致、每个是概率、Σp = 1（容差 0.02）。 */
function decodeDistribution(
  value: unknown,
  allowed: readonly string[],
  id: string,
  argmaxOf?: string,
): Record<string, number> {
  if (!record(value)) {
    reject('distribution-complete', `答案 "${id}" 没有完整概率分布`, id)
  }
  const distribution = value as Record<string, unknown>
  const keys = Object.keys(distribution)
  if (keys.length !== allowed.length || allowed.some((key) => !Object.hasOwn(distribution, key))) {
    reject('distribution-complete', `答案 "${id}" 的分布键集合与候选集合不一致`, id)
  }

  let sum = 0
  let max = -Infinity
  const result: Record<string, number> = {}
  for (const key of allowed) {
    const chance = distribution[key]
    if (!probability(chance)) reject('probability-range', `答案 "${id}" 的 "${key}" 不是 [0,1] 内的有限数`, id)
    result[key] = chance
    sum += chance
    if (chance > max) max = chance
  }

  if (Math.abs(sum - 1) > NORMALIZATION_TOLERANCE) {
    reject('distribution-normalized', `答案 "${id}" 的概率和 ${sum} 偏离 1 超过容差 ${NORMALIZATION_TOLERANCE}`, id)
  }
  if (argmaxOf !== undefined && result[argmaxOf]! < max - ARGMAX_TOLERANCE) {
    reject('argmax-consistent', `choice "${id}" 选中的候选不是分布众数`, id)
  }
  return result
}

/** 计量：缺项即"未知"，**不当作 0**；非法计数直接忽略并让 `complete` 报 false。 */
function decodeUsage(value: unknown): DecodedUsage | undefined {
  if (value === undefined || value === null) return undefined
  if (!record(value)) return {}
  const count = (input: unknown): number | undefined =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : undefined
  const inputTokens = count(value.input_tokens)
  const outputTokens = count(value.output_tokens)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  }
}

/**
 * 独立于答案校验地读出已知计数。
 *
 * 用途：响应被严格校验拒绝时，这次调用**钱已经花了**，计量必须留住（§12.5 的
 * `knownUsage` 纪律——拒绝响应时仍保留 usage）。
 */
export function knownUsage(raw: unknown): DecodedUsage | undefined {
  if (!record(raw)) return undefined
  return decodeUsage(raw.usage)
}
