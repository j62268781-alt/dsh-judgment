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
 * **证据等级**（2026-10-20 补）：
 * - 官方文档站 `developers.openai.com/api/docs/guides/decisions` 对脚本抓取返回 403，
 *   所以**没有**直接读到官方原文；
 * - 但有两份可核对的独立公开来源：
 *   ① promptfoo 的 `openai:decisions` provider 文档（2026-10-19 更新，逐条列出了
 *   请求/答案形状与约束）—— https://www.promptfoo.dev/docs/providers/openai-decisions/
 *   ② 一个**同时调用两家真实 API** 的对比项目（含价格、模型名、端点）
 *   —— https://github.com/Neha/jev-vs-openai-decisions
 * 据此已确认：端点 `POST /v1/decisions`、模型 `gpt-6-luna`、只按输入计费（$0.10/1M，输出免费）、
 * `predicate` 答案只有 `probability`（无 confidence）、`choice` / `score` 答案带
 * `probabilities` **数组** + `confidence`、`score` 是**0 基级别的概率加权均值**
 * （可落在两级之间——与 SystemOne 的期望值语义**相同**，早先"疑似下标"的猜测是错的）、
 * 拒答是 `{ name, type: 'refusal' }` 且不影响同批其它问题、`answers` **保持问题顺序**、
 * 省略 `name` 时该字段为 `null`。
 *
 * ⚠️ **仍未对着真实端点实测**（手上没有这条连接与密钥）。剩下三处只能等真机确认，
 * 代码对它们都取"宽容读取、语义照严"的策略（见文件末尾"待验证点"）。
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
    // 文档（promptfoo `openai:decisions` provider，2026-10-19 更新）写得很明确：
    // `levels` 是 2–10 个 `{ label, description? }`，按**低 → 高**排序，
    // `label` 是给人看的级别名；级别下标由 API 在答案里给出（见解码侧对 `index` 的兼容）。
    // 所以这里**不能**把下标塞进 label——那是我们早期的猜测，会把级别名挤进 description。
    return {
      name: id,
      type: 'score',
      instructions,
      levels: question.levels.map((level, index) => ({
        label: level === null || level === '' ? String(index) : text(level),
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

  // `answers` 与 `questions` **顺序一一对应**（文档明说 "Answers preserve question order"），
  // 逐项回显 `name`；省略 name 时该字段为 `null`。所以两种映射都要支持：
  // 有 name 就用 name（更稳），没有 name 就按**下标**对（顺序是协议保证，不是猜）。
  const positional = new Map<number, Record<string, unknown>>()
  const byName = new Map<string, Record<string, unknown>>()
  for (const [index, value] of list.entries()) {
    if (value === null) continue
    if (!isRecord(value)) reject('answer-set-equality', '答案项不是对象')
    const name = value.name
    if (name === undefined || name === null || name === '') {
      positional.set(index, value)
      continue
    }
    if (typeof name !== 'string') reject('answer-set-equality', '答案的 name 不是字符串')
    if (byName.has(name)) reject('answer-set-equality', `答案 "${name}" 重复出现`, name)
    if (!Object.hasOwn(questions, name)) {
      reject('answer-set-equality', `多出一个未提问的答案 "${name}"`, name)
    }
    byName.set(name, value)
  }

  const answers: Record<string, JudgmentAnswer> = {}
  expected.forEach((id, index) => {
    // 数组里整项为 null = 结构合法地"没有判断"（与 SystemOne 的 null 答案同义）。
    const value = byName.get(id) ?? positional.get(index)
    answers[id] = value === undefined
      ? { kind: 'abstain', reason: 'no-answer' }
      : decodeAnswer(value, questions[id]!, id)
  })

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
  // `score` 的语义**已定稿**（文档原文：levels 用 0 基下标，`score` 是下标的
  // **概率加权均值**，所以可以落在两级之间）——与 SystemOne 的期望值语义相同。
  // 原样透传，不取整、不四舍五入：它本身就是连续位置。
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
 * 本协议用**数组**装分布。文档只说"完整 probabilities 数组"，没给字段名，所以两处取宽容：
 *
 * 1. 键字段接受 `value`（choice 的候选值）**或** `index`（score 的级别下标）——
 *    两种都在公开实现里出现过，硬认一种会在真机上整批误拒；
 * 2. `label` 是**可选展示字段**：有就必须是字符串，没有不影响判定
 *    （choice 的分布项文档里根本没提 label，早先把它当必填也是过严）。
 *
 * 注意"宽容"只针对**字段名/展示字段**；数值本身照严：集合一致、[0,1]、Σp 容差、
 * argmax 一致性一个都不放过——那是"答案是否可信"的判断，不能将就。
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
    const raw = item.value !== undefined ? item.value : item.index
    const key = typeof raw === 'number' ? String(raw) : raw
    if (valueKind === 'string' ? typeof raw !== 'string' : !Number.isInteger(raw)) {
      reject('distribution-complete', `答案 "${id}" 的分布项既没有合法的 value 也没有 index`, id)
    }
    if (typeof key !== 'string' || !allowed.includes(key)) {
      reject('distribution-complete', `答案 "${id}" 的分布项 "${String(raw)}" 不是候选/级别之一`, id)
    }
    if (item.label !== undefined && typeof item.label !== 'string') {
      reject('distribution-complete', `答案 "${id}" 的分布项 label 不是字符串`, id)
    }
    if (result.has(key)) reject('distribution-complete', `答案 "${id}" 的分布项 "${key}" 重复`, id)
    result.set(key, item.probability)
  }
  return result
}

/**
 * 待验证点（有一条真实 `openai-decisions` 连接后逐条核对并回填实测结果）。
 *
 * 已经**不用**再验的（本轮据公开文档定稿）：
 * - `score` 语义 = 0 基级别的概率加权均值，可落在两级之间（与 SystemOne 相同）；
 * - 拒答形状 = `{ name, type: 'refusal' }`，且不影响同批其它问题；
 * - `predicate` 答案无 confidence；`choice` / `score` 答案有 `probabilities` + `confidence`；
 * - `answers` 保持问题顺序；省略 name 时该字段为 `null`。
 *
 * 仍然只有真机能定的三处（代码现在对它们都取宽容读取）：
 * 1. 分布项的键字段到底是 `value` 还是 `index`（两者都接）；
 * 2. 非拒答答案是否也带 `type`（有就校验一致性，没有就按问题原语解读）；
 * 3. 响应是否回显 `model`（回显则严格校验快照，不回显则退回配置里的模型名）。
 *
 * 另一处**刻意不跟**的地方：promptfoo 用自己的 ±1pp 容差做客户端校验，
 * 我们按契约统一用 0.02（`bridge.mjs:95` 的源码级数值）。容差属于契约，不随第三方实现漂移。
 */
