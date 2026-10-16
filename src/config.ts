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

/** 凭据**引用名**，不是密钥值——密钥由 DSH 凭据服务保管（§13.2）。空 = 尚未配置。 */
const CREDENTIAL_REF = /^(?:$|[A-Za-z_][A-Za-z0-9_]*)$/

/**
 * 窗口内配额（`0` = 不限）。窗口固定 **1 小时**——够用，且不必给用户再加一个时间窗旋钮。
 *
 * 配额是**成本护栏**，不是判断逻辑：耗尽时 provider 以 `quota-exceeded` 明确拒绝，
 * 但绝不自作主张换一条连接或降级到别的模型（§13.6）。
 */
const Quota = s.object({
  callsPerHour: s.number().step(1).min(0).max(1_000_000).default(0),
  inputTokensPerHour: s.number().step(1).min(0).max(1_000_000_000).default(0),
})

export const Config = s.object({
  connections: s.dict(s.object({
    /** 协议身份，显式选择；不由 URL 推断（§12.6）。 */
    // 协议身份**显式**且**开放**：契约的 `ProtocolId` 允许第三方实现自报身份
    // （jevos / AnyJev / vllm-jev…），所以这里按形状校验而不是列举字面量；
    // 未接归一化层的协议会在调用时以类型化失败 `internal` 明确拒绝，
    // 绝不"猜一个最像的协议"去迎合端点（§12.6）。
    // 配置页的下拉框仍然只列已实现的那些（那是建议，不是围栏）。
    protocol: s.string().pattern(/^[a-z][a-z0-9-]{0,63}$/).default('system-one'),
    /** 规范化 endpoint。空字符串表示尚未配置。 */
    baseUrl: s.string().pattern(BASE_URL).default('https://api.typesafe.ai/v1/systemone'),
    /** 必须 pin 到具体版本并记录响应快照，不要用 `jev-latest` 这类移动别名（§13.4）。 */
    model: s.string().pattern(/^\S+$/).default('typesafe/jev-1.13'),
    /**
     * 凭据引用名。**默认留空**：一个写死的默认值会让多条连接共用一个引用名而互相覆盖，
     * 所以引用名由配置页自动分配（JUDGMENT_API_KEY_{序号}）（`typesafe-main` → `TYPESAFE_MAIN_API_KEY`），
     * 手写配置时也可以自己填。空字符串表示这个连接还没有密钥。
     */
    credentialRef: s.string().pattern(CREDENTIAL_REF).default(''),
    timeoutMs: s.number().step(1).min(1).max(300_000).default(10_000),
    /** 这条连接的逐小时配额。 */
    quota: Quota.default({}),
  })).default({}).volatile(),

  /** 用途名 → 连接。消费者只报用途名（`mobile.action` / `browser.action` / `compaction.retain` …）。 */
  purposes: s.dict(s.object({
    /** 指向 `connections` 的键；空字符串表示用 `defaultConnection`。 */
    connection: s.string().default(''),
    /** 这个用途的逐小时配额（与连接层配额各自独立，两个都要过）。 */
    quota: Quota.default({}),
  })).default({}).volatile(),

  /** 调用方没给用途名时用的连接；留空且只配了一条连接时用那一条。 */
  defaultConnection: s.string().default('').volatile(),

  /**
   * 审计 ledger：每次尝试**发包前**先落一条 `dispatch`，回来后补一条 `settled`。
   *
   * 为什么落盘：它既是"这次判断是谁做的、花了多少"的唯一凭据，也是逐小时配额的计数来源
   * （进程重启后配额不该归零）。落盘失败**不会**阻断判断——文件写不进去不该不给你判断——
   * 但会通过日志说出来。
   */
  ledger: s.object({
    enabled: s.boolean().default(true),
    /** 空 = `$DSH_HOME/judgment-ledger.jsonl`。 */
    path: s.string().default(''),
  }).default({}).volatile(),
})

/** 解开 `.volatile()` 的包装，拿到真实值类型——volatile 字段要用 `.get()` 读。 */
type Live<T> = T extends Volatile<infer I> ? I : T

/** 校验后的配置值类型（schemastery 的输出类型）。 */
export type JudgmentConfig = typeof Config extends s<any, infer T> ? T : never
export type Connections = Live<JudgmentConfig['connections']>
export type Purposes = Live<JudgmentConfig['purposes']>
export type LedgerConfig = Live<JudgmentConfig['ledger']>
/** 一条连接的配置（普通值，读出来就是它）。 */
export type ConnectionConfig = Connections[string]
/** 一个用途的配置。 */
export type PurposeConfig = Purposes[string]
/** 逐小时配额。 */
export type QuotaConfig = ConnectionConfig['quota']
