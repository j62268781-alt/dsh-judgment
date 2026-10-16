/**
 * **OpenAI-Decisions**（协议里的 `predicate`）线格式：编码 + 严格解码。
 *
 * 这是**第二套协议**，用来验证"一套归一化 schema 够不够用"（§13.7 P0′ 的核心问题）。
 * 线格式抄自调研目录里那份可运行实现（`/tmp/jev-survey/dsh-jev-plugin` 的
 * `wire.ts: protocolBody` / `parseProtocolResponse`，对应它的 `luna-openai` 连接），
 * 与 SystemOne 的差异是**结构性的四处**：
 *
 * | | SystemOne (`noul`) | OpenAI-Decisions (`predicate`) |
 * |---|---|---|
 * | 状态字段 | `state`（任意 JSON） | `input`（**字符串**，非字符串要 `JSON.stringify`） |
 * | 问题容器 | `questions` 是**对象**（id 作键） | `questions` 是**数组**（`name` 字段） |
 * | 答案容器 | `answers` 是**对象** | `answers` 是**数组**，靠 `name` 反查 |
 * | 分布表示 | `probabilities: { id: p }` | `probabilities: [{ value, probability, label }]` |
 *
 * ⚠️ **诚实标注：本协议尚未对着真实端点实测过**——手上没有 `openai-decisions` 的连接与密钥。
 * 它是按上游实现逐条写出来的，靠单测固件钉住形状；等有一条真实连接，第一件事就是
 * `pnpm probe` 打一次，然后把实测差异补进注释与固件（SystemOne 就是那么校准的：
 * 那次实测改掉了 `score` 的语义）。已知的待验证点写在本文件末尾。
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
  decodeSignals,
  decodeUsage,
  isProbability,
  isRecord,
  reject,
  validateDistribution,
  type DecodedResponse,
} from './wire.js'

export type { DecodedResponse }

/** 协议里"判断"这一原语的名字。 */
const PREDICATE = 'predicate'

/** 非字符串载荷按上游做法序列化成文本（`state` 与 `instructions` 都用它）。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'
}

/* ─────────────────────────────── 编码 ─────────────────────────────── */

/** 一批问题 → OpenAI-Decisions 请求体。 */
export function encodeBody(
  model: string,
  state: JudgmentState,
  questions: JudgmentQuestions,
): Record<string, unknown> {
  return {
    model,
    input: text(state),
    questions: Object.entries(questions).map(([id, question]) => encodeQuestion(id, question)),
  }
}

function encodeQuestion(id: string, question: JudgmentQuestion): Record<string, unknown> {
  const instructions = text(question.prompt)
  if (question.kind === 'choice') {
    return {
      name: id,
      type: 'choice',
      instructions,
      choices: Object.entries(question.options).map(([value, description]) => ({
        value,
        // 空说明整字段不发，别送一个空串去污染判据。
        ...(description === null || description === '' ? {} : { description: text(description) }),
      })),
    }
  }
  if (question.kind === 'score') {
    return {
      name: id,
      type: 'score',
      instructions,
      levels: question.levels.map((level, index) => ({
        label: String(index),
        ...(level === null || level === '' ? {} : { description: text(level) }),
      })),
    }
  }
  return {
    name: id,
    type: PREDICATE,
    // 有判据时上游把 `{instructions, criteria}` 整体序列化进 instructions（协议就这么规定）。
    instructions: question.criteria === undefined
      ? instructions
      : JSON.stringify({ instructions: question.prompt, criteria: question.criteria }),
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
  const list = body.answers
  if (!Array.isArray(list)) reject('answer-set-equality', '响应里没有 answers 数组')

  const expected = Object.keys(questions)
  if (list.length !== expected.length) {
    reject('answer-set-equality', `答案数 ${list.length} 与问题数 ${expected.length} 不一致`)
  }

  const byName = new Map<string, Record<string, unknown>>()
  for (const value of list) {
    if (value === null) continue
    if (!isRecord(value)) reject('answer-set-equality', '答案项不是对象')
    const name = value.name
    if (typeof name !== 'string' || name === '') reject('answer-set-equality', '答案缺少 name')
    if (byName.has(name)) reject('answer-set-equality', `答案 "${name}" 重复出现`, name)
    if (!Object.hasOwn(questions, name)) {
      reject('answer-set-equality', `多出一个未提问的答案 "${name}"`, name)
    }
    byName.set(name, value)
  }

  const answers: Record<string, JudgmentAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    // 数组里整项为 null = 结构合法地"没有判断"（与 SystemOne 的 null 答案同义）。
    const value = byName.get(id)
    answers[id] = value === undefined ? { kind: 'abstain', reason: 'no-answer' } : decodeAnswer(value, question, id)
  }

  const usage = decodeUsage(body.usage)
  return {
    answers,
    // 本协议**是否回显 model 尚未实测**：回显了就按快照严格校验，没回显就退回配置里的模型名。
    // 这个分歧要在第一次真网探测时定案（见文件末尾"待验证点"）。
    model: body.model === undefined ? expectedModel : decodeConfiguredModel(body.model, expectedModel),
    ...(usage === undefined ? {} : { usage }),
    ...(typeof body.request_id === 'string' ? { requestId: body.request_id } : {}),
  }
}

function decodeConfiguredModel(value: unknown, expected: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    reject('model-name', '响应里的 model 不是非空字符串')
  }
  if (value !== expected && !/latest/i.test(expected)) {
    reject('model-name', `响应模型快照 "${value}" 与配置的 "${expected}" 不一致`)
  }
  return value
}

function decodeAnswer(value: Record<string, unknown>, question: JudgmentQuestion, id: string): JudgmentAnswer {
  if (value.type === 'refusal' || value.refusal !== undefined) {
    return { kind: 'abstain', reason: 'refusal' }
  }
  const expectedType = question.kind === 'noul' ? PREDICATE : question.kind
  if (value.type !== undefined && value.type !== expectedType) {
    reject('answer-shape', `答案 "${id}" 的类型 ${String(value.type)} 与问题原语 ${question.kind} 不一致`, id)
  }

  // 上游对 choice / score 要求 confidence 必填（对 predicate 不要求），照此对齐。
  const signals = decodeSignals(value, id, { requireConfidence: question.kind !== 'noul' })
  if (question.kind === 'noul') {
    if (!isProbability(value.probability)) {
      reject('answer-shape', `predicate "${id}" 的概率缺失或不在 [0,1]`, id)
    }
    return { kind: 'noul', probability: value.probability, ...signals } satisfies NoulAnswer
  }

  if (question.kind === 'choice') {
    const optionIds = Object.keys(question.options)
    if (typeof value.choice !== 'string' || !optionIds.includes(value.choice)) {
      reject('answer-shape', `choice "${id}" 选中的候选不在候选集合里`, id)
    }
    const probabilities = validateDistribution(
      arrayDistribution(value.probabilities, optionIds, id, 'string'), optionIds, id, value.choice,
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
  // 本协议的 score 疑似是**级别下标**（与 SystemOne 的期望值语义不同）；原样透传，不猜不取整。
  const probabilities = validateDistribution(
    arrayDistribution(value.probabilities, levelKeys, id, 'integer'), levelKeys, id,
  )
  return {
    kind: 'score',
    value: score,
    probabilities: probabilities as NormalizedDistribution<`${number}`>,
    ...signals,
  } satisfies ScoreAnswer
}

/**
 * 本协议用**数组**装分布：`[{ value, probability, label }]`。
 * choice 的 `value` 是候选 id（字符串），score 的 `value` 是级别下标（整数）。
 */
function arrayDistribution(
  value: unknown,
  allowed: readonly string[],
  id: string,
  valueKind: 'string' | 'integer',
): Map<string, unknown> {
  if (!Array.isArray(value)) reject('distribution-complete', `答案 "${id}" 没有完整概率分布`, id)
  const result = new Map<string, unknown>()
  for (const item of value) {
    if (!isRecord(item)) reject('distribution-complete', `答案 "${id}" 的分布项不是对象`, id)
    const raw = item.value
    const key = typeof raw === 'number' ? String(raw) : raw
    if (valueKind === 'string' ? typeof raw !== 'string' : !Number.isInteger(raw)) {
      reject('distribution-complete', `答案 "${id}" 的分布项 value 类型不对`, id)
    }
    if (typeof key !== 'string' || !allowed.includes(key)) {
      reject('distribution-complete', `答案 "${id}" 的分布项 value "${String(raw)}" 不是候选/级别之一`, id)
    }
    if (typeof item.label !== 'string') {
      reject('distribution-complete', `答案 "${id}" 的分布项缺少 label`, id)
    }
    if (result.has(key)) reject('distribution-complete', `答案 "${id}" 的分布项 "${key}" 重复`, id)
    result.set(key, item.probability)
  }
  return result
}

/**
 * 待验证点（有一条真实 `openai-decisions` 连接后逐条核对并回填实测结果）：
 * 1. 响应是否回显 `model`（现在回显就严格校验，不回显就退回配置名）；
 * 2. `score` 到底是级别下标还是像 SystemOne 那样的**期望值**（语义不同，消费者读法也不同）；
 * 3. 分布项除了 `value/probability/label` 还有没有别的必备字段；
 * 4. 拒答是 `type:'refusal'` 还是别的形状（现在按上游实现认这两种）。
 */
