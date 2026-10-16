/**
 * 发包前的请求校验：**零成本拒绝**——不合规的请求不该花掉一次网络往返。
 *
 * 规则清单见契约的 `ValidationRule`。这里只产出结构化的 `ValidationFailure`，
 * 由 Service 包成 `invalid-request`（`ask`）或写进 `health().failure`。
 * **失败即拒、绝不"修复"**（§9.5）。
 */

import type {
  JudgmentQuestions,
  JudgmentQuestion,
  JudgmentState,
  ValidationFailure,
} from '../contract/index.js'

/** 协议硬边界（与契约 `JudgmentLimits` 同源；改这里必须同时改契约的文档）。 */
export const LIMITS = {
  choiceOptions: { min: 2, max: 255 },
  scoreLevels: { min: 2, max: 10 },
} as const

/** 可 JSON 序列化且有限的载荷（与契约 `JudgmentJson` 同构的运行时判据）。 */
export function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJson)
  return false
}

/** 文本：非空字符串（空白不算）。 */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(rule: ValidationFailure['rule'], detail: string, questionId?: string): ValidationFailure {
  return { rule, detail, ...(questionId === undefined ? {} : { questionId }) }
}

/** 校验一批问题；返回第一个失败，全部通过则返回 undefined。 */
export function validateRequest(
  state: JudgmentState,
  questions: JudgmentQuestions,
): ValidationFailure | undefined {
  if (!isJson(state)) return fail('state-serializable', 'state 必须是可 JSON 序列化的有限值')
  if (!record(questions)) return fail('questions-nonempty', 'questions 必须是「问题 id → 问题」的映射')
  const entries = Object.entries(questions)
  if (entries.length === 0) return fail('questions-nonempty', '至少要有 1 个问题')

  for (const [id, question] of entries) {
    const identity = validateQuestion(id, question)
    if (identity !== undefined) return identity
  }
  return undefined
}

function validateQuestion(id: string, question: JudgmentQuestion): ValidationFailure | undefined {
  if (id.trim() === '') return fail('question-identity', '问题 id 不能为空')
  if (!record(question)) return fail('question-identity', `问题 "${id}" 不是对象`, id)

  const kind = question.kind
  if (kind !== 'noul' && kind !== 'choice' && kind !== 'score') {
    return fail('question-identity', `问题 "${id}" 的 kind 不是 noul / choice / score`, id)
  }
  if (!isText(question.prompt)) return fail('question-identity', `问题 "${id}" 的 prompt 必须是非空文本`, id)

  if (kind === 'choice') {
    const options = question.options
    if (!record(options)) return fail('choice-arity', `choice "${id}" 缺少 options 映射`, id)
    const ids = Object.keys(options)
    if (ids.length < LIMITS.choiceOptions.min || ids.length > LIMITS.choiceOptions.max) {
      return fail('choice-arity', `choice "${id}" 的候选数 ${ids.length} 不在 ${LIMITS.choiceOptions.min}–${LIMITS.choiceOptions.max}`, id)
    }
    for (const option of ids) {
      if (option.trim() === '') return fail('choice-arity', `choice "${id}" 有空的候选 id`, id)
      const description = options[option]
      if (description !== null && !isText(description)) {
        return fail('choice-arity', `choice "${id}" 的候选 "${option}" 说明必须是文本或 null`, id)
      }
    }
    return undefined
  }

  if (kind === 'score') {
    const levels = question.levels
    if (!Array.isArray(levels)) return fail('score-arity', `score "${id}" 缺少 levels`, id)
    if (levels.length < LIMITS.scoreLevels.min || levels.length > LIMITS.scoreLevels.max) {
      return fail('score-arity', `score "${id}" 的级别数 ${levels.length} 不在 ${LIMITS.scoreLevels.min}–${LIMITS.scoreLevels.max}`, id)
    }
    for (const level of levels) {
      if (level !== null && !isText(level)) return fail('score-arity', `score "${id}" 的级别说明必须是文本或 null`, id)
    }
    return undefined
  }

  const criteria = question.criteria
  if (criteria !== undefined) {
    if (!record(criteria)) return fail('question-identity', `noul "${id}" 的 criteria 必须是对象`, id)
    for (const side of ['true', 'false'] as const) {
      const value = criteria[side]
      if (value !== undefined && value !== null && !isText(value)) {
        return fail('question-identity', `noul "${id}" 的 criteria.${side} 必须是文本或 null`, id)
      }
    }
  }
  return undefined
}
