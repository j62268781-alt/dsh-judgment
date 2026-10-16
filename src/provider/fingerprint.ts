/**
 * 快照指纹：`hash(规则版本 + 脱敏版本 + 连接身份 + 请求体)`。
 *
 * 直接抄 `dsh-jev-plugin` 的「指纹三件套」（§12.5），不重写：规则或脱敏版本一变，
 * 旧指纹自然作废。**不含**本次尝试的血缘（`inputVersion` 属于 ledger，不属于指纹），
 * 所以执行侧算出的指纹与答案携带的指纹可以逐字比较（不变量 1，§10.2）。
 *
 * 纯本地、同步、零 I/O：不读凭据明文、不发网络请求。
 */

import { createHash } from 'node:crypto'
import type { Fingerprint, JudgmentQuestions, JudgmentState } from '../contract/index.js'

/** 规则版本：判定规则或校验容差变化时必须递进。 */
export const RULE_VERSION = 'judgment-v1'
/** 脱敏版本：送出去的状态经过哪些脱敏处理。 */
export const REDACTION_VERSION = 'none-v1'

/** 进入指纹的连接身份（协议身份必须在内，§12.6）。 */
export interface FingerprintIdentity {
  readonly connection: string
  readonly protocol: string
  readonly baseUrl: string
  readonly model: string
}

/** 稳定序列化：对象键排序、数组保序、跳过 undefined，保证同一输入同一字节串。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export function fingerprint(
  identity: FingerprintIdentity,
  state: JudgmentState,
  questions: JudgmentQuestions,
): Fingerprint {
  const body = canonical({
    rule: RULE_VERSION,
    redaction: REDACTION_VERSION,
    identity,
    state,
    questions,
  })
  return createHash('sha256').update(body).digest('hex') as Fingerprint
}
