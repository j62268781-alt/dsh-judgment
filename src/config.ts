/**
 * 两层配置模型（§13.4，本设计的核心差异化）：
 *
 * - **连接层** `connections`：一个 `(protocol, baseUrl, model, credentialRef)` 元组 = 一条连接，
 *   协议身份**显式**（§12.6：换 hostname 不切协议）。
 * - **用途层** `purposes`：按用途命名，指向一条连接。消费者只报用途名，不接触 endpoint / model / key，
 *   所以「手机用一个模型、浏览器用另一个」是配置问题而不是代码问题。
 *
 * 两层都是字典，所以「加第 N 个用途」是纯配置——这正是相对上游写死 feature 列表的差异化。
 *
 * 热更新：`.volatile()` 标在**容器**字段上（`connections` / `purposes` / `defaultConnection`），
 * 读的时候用 `.get()` 现取。DSH 的 volatile 快照以字段为单位，容器一变整份值就是新的，
 * 所以不必给每个叶子都加 `.volatile()`——那只会让每个叶子都变成 `Volatile<T>` 包装。
 */

import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'

/** 归一化后的 endpoint：不含凭据、query、hash（§12.6 的 safeUrl 纪律）。 */
const BASE_URL = /^(?:$|https?:\/\/(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?(?:\/[^?#\s]*)?)$/

/** 凭据**引用名**，不是密钥值——密钥由 DSH 凭据服务保管（§13.2）。 */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

export const Config = s.object({
  connections: s.dict(s.object({
    /** 协议身份，显式选择；不由 URL 推断（§12.6）。 */
    protocol: s.union(['system-one', 'openai-decisions']).default('system-one'),
    /** 规范化 endpoint。空字符串表示尚未配置。 */
    baseUrl: s.string().pattern(BASE_URL).default('https://api.typesafe.ai/v1/systemone'),
    /** 必须 pin 到具体版本并记录响应快照，不要用 `jev-latest` 这类移动别名（§13.4）。 */
    model: s.string().pattern(/^\S+$/).default('typesafe/jev-1.13'),
    /** 凭据引用名（如 `TYPESAFE_API_KEY`）；provider 每次调用现取，不缓存明文。 */
    credentialRef: s.string().pattern(CREDENTIAL_REF).default('TYPESAFE_API_KEY'),
    timeoutMs: s.number().step(1).min(1).max(300_000).default(10_000),
  })).default({}).volatile(),

  /** 用途名 → 连接。消费者只报用途名（`mobile.action` / `browser.action` / `compaction.retain` …）。 */
  purposes: s.dict(s.object({
    /** 指向 `connections` 的键；空字符串表示用 `defaultConnection`。 */
    connection: s.string().default(''),
  })).default({}).volatile(),

  /** 调用方没给用途名时用的连接；留空且只配了一条连接时用那一条。 */
  defaultConnection: s.string().default('').volatile(),
})

/** 解开 `.volatile()` 的包装，拿到真实值类型——volatile 字段要用 `.get()` 读。 */
type Live<T> = T extends Volatile<infer I> ? I : T

/** 校验后的配置值类型（schemastery 的输出类型）。 */
export type JudgmentConfig = typeof Config extends s<any, infer T> ? T : never
export type Connections = Live<JudgmentConfig['connections']>
export type Purposes = Live<JudgmentConfig['purposes']>
/** 一条连接的配置（普通值，读出来就是它）。 */
export type ConnectionConfig = Connections[string]
/** 一个用途的配置。 */
export type PurposeConfig = Purposes[string]
