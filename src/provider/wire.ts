/**
 * 多协议归一化的**共用核心**：容差、严格校验的判据、以及"信号/计量"的解码。
 *
 * 为什么单独一个文件：两套协议（SystemOne 的 `noul` 与 OpenAI-Decisions 的 `predicate`）
 * 的**线格式不同**（一个用对象装分布、一个用数组），但**校验纪律完全相同**。
 * 契约明确警告过"留给消费者就会出现多份实现并必然漂移"（§13.2），所以容差与判据只允许
 * 有一份。协议模块只负责"把各自的线格式翻译成这里的判据"。
 */

import type {
  JudgmentAnswer,
  JudgmentJson,
  Probability,
  ValidationFailure,
  ValidationRule,
} from '../contract/index.js'

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

/** 一套协议解码出一批答案后的**归一化结果**：所有协议都收敛到这个形状。 */
export interface DecodedResponse {
  readonly answers: Record<string, JudgmentAnswer>
  /** 响应返回的模型快照（协议回显时是快照，不回显时见各协议模块的说明）。 */
  readonly model: string
  readonly usage?: DecodedUsage
  /** 上游的请求 id（有的话），供审计 ledger 对齐。 */
  readonly requestId?: string
}

/** 一批响应里可选的信号，原样透传（协议没给就**绝不合成**，§13.2 铁律）。 */
export interface DecodedSignals {
  readonly confidence?: Probability
  readonly legend?: JudgmentJson
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isProbability(value: unknown): value is Probability {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * 可选的结构化数值，随 {@link ValidationFailure} 一起交给消费者。
 *
 * 为什么不只给字符串：消费者要做的是**确定性决策**（缩到多少候选重采），
 * 从 `detail` 里正则抠数字既脆又等价于让每个消费者各写一份解析。
 */
export interface ValidationNumbers {
  readonly optionCount?: number
  readonly sum?: number
  readonly tolerance?: number
}

export function reject(
  rule: ValidationRule,
  detail: string,
  questionId?: string,
  numbers?: ValidationNumbers,
): never {
  throw new ResponseRejected({
    rule,
    detail,
    ...(questionId === undefined ? {} : { questionId }),
    ...(numbers === undefined ? {} : numbers),
  })
}

/**
 * 分布校验：键集合必须与候选/级别完全一致、每个都是 [0,1] 的概率、Σp = 1（容差 0.02）；
 * 对 choice 另查"选中的候选必须是众数"（容差 1e-6）。
 *
 * `values` 是协议模块翻译后的 `键 → 概率` 映射（键序按 `allowed` 重新输出）。
 */
export function validateDistribution(
  values: ReadonlyMap<string, unknown>,
  allowed: readonly string[],
  questionId: string,
  argmaxOf?: string,
): Record<string, number> {
  const optionCount = allowed.length
  if (values.size !== allowed.length || allowed.some((key) => !values.has(key))) {
    reject(
      'distribution-complete',
      `答案 "${questionId}" 的分布键集合与候选集合不一致`,
      questionId,
      { optionCount },
    )
  }

  let sum = 0
  let max = -Infinity
  const result: Record<string, number> = {}
  for (const key of allowed) {
    const chance = values.get(key)
    if (!isProbability(chance)) {
      reject(
        'probability-range',
        `答案 "${questionId}" 的 "${key}" 不是 [0,1] 内的有限数`,
        questionId,
        { optionCount },
      )
    }
    result[key] = chance
    sum += chance
    if (chance > max) max = chance
  }

  if (Math.abs(sum - 1) > NORMALIZATION_TOLERANCE) {
    reject(
      'distribution-normalized',
      `答案 "${questionId}" 的概率和 ${sum} 偏离 1 超过容差 ${NORMALIZATION_TOLERANCE}`,
      questionId,
      { optionCount, sum, tolerance: NORMALIZATION_TOLERANCE },
    )
  }
  if (argmaxOf !== undefined && result[argmaxOf]! < max - ARGMAX_TOLERANCE) {
    reject('argmax-consistent', `答案 "${questionId}" 选中的候选不是分布众数`, questionId, { optionCount })
  }
  return result
}

/**
 * 模型快照校验。
 *
 * 响应里的 `model` 必须是非空字符串；与配置**逐字相同**才算通过——唯一的例外是配置用了
 * 移动别名（`…-latest`），那时允许快照落到具体版本上（§13.4：pin 并记录快照）。
 */
export function decodeModel(value: unknown, expected: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    reject('model-name', '响应没有返回模型快照——无法确认这次判断是谁做的')
  }
  if (value !== expected && !/latest/i.test(expected)) {
    reject('model-name', `响应模型快照 "${value}" 与配置的 "${expected}" 不一致`)
  }
  return value
}

/** `confidence` / `legend` 原样透传；协议没给就绝不合成。 */
export function decodeSignals(
  source: Record<string, unknown>,
  questionId: string,
  options: { readonly requireConfidence?: boolean } = {},
): DecodedSignals {
  const signals: { confidence?: Probability; legend?: JudgmentJson } = {}
  if (source.confidence !== undefined) {
    if (!isProbability(source.confidence)) {
      reject('answer-shape', `答案 "${questionId}" 的 confidence 不在 [0,1]`, questionId)
    }
    signals.confidence = source.confidence
  } else if (options.requireConfidence === true) {
    reject('answer-shape', `答案 "${questionId}" 缺少 confidence`, questionId)
  }
  if (source.legend !== undefined) {
    if (!isJsonValue(source.legend)) {
      reject('answer-shape', `答案 "${questionId}" 的 legend 不是可 JSON 序列化的值`, questionId)
    }
    signals.legend = source.legend as JudgmentJson
  }
  return signals
}

/** 可 JSON 序列化且有限的载荷（与契约 `JudgmentJson` 同构的运行时判据）。 */
export function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue)
  return false
}

/** 计量：缺项即"未知"，**不当作 0**；非法计数直接忽略并让 `complete` 报 false。 */
export function decodeUsage(value: unknown): DecodedUsage | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) return {}
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
  if (!isRecord(raw)) return undefined
  return decodeUsage(raw.usage)
}
