/**
 * 入口 `"."`：组件 `judgment/provider`，注册 `ctx.judgment`。
 *
 * **零工具**（§13.5）——工具面是另一个组件 `judgment/llm-face`，默认关，首版不做。
 * provider 只做四件"单例"事：凭据、多协议归一化、严格校验、审计与计量；加了指纹。
 * 它不观察、不枚举、不寻址、不门控、不做 fallback、不碰 loop（§13.2「绝不」列）。
 *
 * 当前里程碑（M2）：
 * - 已实现：Service 注册、两层配置解析、`status()`、`fingerprint()`（纯本地）。
 * - 待实现：`ask()` / `health()` 的协议层——按 §0.4 的硬性前置，**先做 §13.7 的 P0′
 *   协议探针**（TypeSafe SystemOne + OpenRouter + 一个 OpenAI 兼容），再写归一化层。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ApiVersion,
  AskOptions,
  ConnectionStatus,
  Fingerprint,
  FingerprintOptions,
  HealthOptions,
  Judge,
  JudgeHealth,
  JudgeStatus,
  JudgmentQuestions,
  JudgmentResult,
  JudgmentState,
  JudgmentTarget,
  PurposeStatus,
} from './contract/index.js'
import { Config, type ConnectionConfig, type JudgmentConfig } from './config.js'
import { JudgmentError, failureOf } from './provider/error.js'
import { fingerprint as computeFingerprint } from './provider/fingerprint.js'

export { Config } from './config.js'
export { JudgmentError, isJudgmentError } from './provider/error.js'
export type { JudgmentConfig, ConnectionConfig, PurposeConfig, Connections, Purposes } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 结构化判断能力。它判断，消费者决定（§13.1）。 */
    judgment: JudgmentService
  }
}

/** 契约版本：与 contract 的 `ApiVersion` 对齐（消费者本地 `EXPECTED` 也写 1）。 */
export const API_VERSION: ApiVersion = 1

interface ResolvedConnection {
  readonly id: string
  readonly entry: ConnectionConfig
}

export class JudgmentService extends Service implements Judge {
  static inject = ['credentials']
  static Config = Config

  readonly apiVersion: ApiVersion = API_VERSION

  /**
   * 最近一次从凭据服务读到的"是否已设值"快照（`status()` 是同步的，不能做 I/O）。
   * 由 `health()` / `ask()` 刷新；只存布尔，永不存密钥值（§13.2）。
   */
  private readonly credentialPresent = new Map<string, boolean>()

  constructor(ctx: Context, private readonly config: JudgmentConfig) {
    super(ctx, 'judgment')
  }

  /**
   * 解析 用途/连接 → 连接层条目。
   *
   * **未知用途绝不静默换连接**（§13.3 第 4 项：降级必须显式可见）；
   * 只有"一条连接都没指定、且恰好只配了一条"才自动选中，避免把配置错误掩盖成可用。
   */
  private resolve(target: JudgmentTarget = {}): ResolvedConnection {
    // volatile 字段每次调用现取——改配置不必重启（§13.4）。
    const connections = this.config.connections.get()
    const purposes = this.config.purposes.get()
    const defaultConnection = this.config.defaultConnection.get()

    if (target.connection !== undefined) {
      const entry = connections[target.connection]
      if (entry === undefined) {
        throw new JudgmentError({
          code: 'unknown-connection', phase: 'resolve', retryable: false,
          message: `连接 "${target.connection}" 未配置`,
        })
      }
      return { id: target.connection, entry }
    }

    if (target.purpose !== undefined) {
      const purpose = purposes[target.purpose]
      if (purpose === undefined) {
        throw new JudgmentError({
          code: 'unknown-purpose', phase: 'resolve', retryable: false,
          message: `用途 "${target.purpose}" 未配置——用途名是配置项，provider 不会替你猜一个`,
        })
      }
      const id = purpose.connection !== '' ? purpose.connection : defaultConnection
      if (id === '') {
        throw new JudgmentError({
          code: 'not-configured', phase: 'resolve', retryable: false,
          message: `用途 "${target.purpose}" 未指向任何连接`,
        })
      }
      const entry = connections[id]
      if (entry === undefined) {
        throw new JudgmentError({
          code: 'unknown-connection', phase: 'resolve', retryable: false,
          message: `用途 "${target.purpose}" 指向的连接 "${id}" 未配置`,
        })
      }
      return { id, entry }
    }

    if (defaultConnection !== '') {
      const entry = connections[defaultConnection]
      if (entry === undefined) {
        throw new JudgmentError({
          code: 'unknown-connection', phase: 'resolve', retryable: false,
          message: `默认连接 "${defaultConnection}" 未配置`,
        })
      }
      return { id: defaultConnection, entry }
    }

    const ids = Object.keys(connections)
    if (ids.length === 1) {
      const id = ids[0]!
      return { id, entry: connections[id]! }
    }
    throw new JudgmentError({
      code: 'not-configured', phase: 'resolve', retryable: false,
      message: ids.length === 0
        ? '尚未配置任何连接'
        : `配置了 ${ids.length} 条连接，请设置 defaultConnection 或调用时给出用途名`,
    })
  }

  /**
   * 本地状态快照（零 I/O）：`configured` 与 `remoteVerified` 分开——
   * "本地显示已配置不代表密钥已验证"（§13.3 第 4 项）。
   */
  status(): JudgeStatus {
    const liveConnections = this.config.connections.get()
    const defaultConnection = this.config.defaultConnection.get()
    const connections: ConnectionStatus[] = Object.entries(liveConnections).map(([connection, entry]) => ({
      connection,
      protocol: entry.protocol,
      model: entry.model,
      ...(entry.baseUrl === '' ? {} : { baseUrl: entry.baseUrl }),
      credentialRef: entry.credentialRef,
      credentialPresent: this.credentialPresent.get(entry.credentialRef) === true,
    }))

    const purposes: PurposeStatus[] = Object.entries(this.config.purposes.get()).map(([purpose, entry]) => {
      const id = entry.connection !== '' ? entry.connection : defaultConnection
      const target = id === '' ? undefined : liveConnections[id]
      if (target === undefined) {
        return {
          purpose,
          ...(id === '' ? {} : { connection: id }),
          usable: false,
          failure: {
            code: 'not-configured', phase: 'resolve', retryable: false,
            message: id === '' ? '用途未指向任何连接' : `用途指向的连接 "${id}" 未配置`,
          },
        }
      }
      return {
        purpose,
        connection: id,
        usable: target.baseUrl !== '' && this.credentialPresent.get(target.credentialRef) === true,
      }
    })

    const configured = connections.length > 0
    return {
      apiVersion: this.apiVersion,
      configured,
      // 远端是否真的通，只能由 health() 的探测回答；这里不猜。
      remoteVerified: false,
      connections,
      purposes,
      ...(configured ? {} : {
        failure: {
          code: 'not-configured', phase: 'resolve', retryable: false,
          message: '尚未配置任何连接：请在 Plugins 页面添加连接与用途',
        },
      }),
    }
  }

  /**
   * 执行侧的新鲜度原语：动作前比对"当前快照"与产生答案的那个快照（不变量 1）。
   * 纯本地、同步、零 I/O。
   */
  fingerprint(state: JudgmentState, questions: JudgmentQuestions, options?: FingerprintOptions): Fingerprint {
    const { id, entry } = this.resolve(options ?? {})
    return computeFingerprint(
      { connection: id, protocol: entry.protocol, baseUrl: entry.baseUrl, model: entry.model },
      state,
      questions,
    )
  }

  /**
   * 一次批量判断。
   *
   * **协议层尚未实现**：按 §0.4 的硬性前置，先跑 §13.7 的 P0′ 协议探针，
   * 再决定归一化层形态。当前先做解析（配置错误会立刻以类型化失败暴露）。
   */
  async ask<Q extends JudgmentQuestions>(
    _state: JudgmentState,
    _questions: Q,
    options?: AskOptions,
  ): Promise<JudgmentResult<Q>> {
    const { id, entry } = this.resolve(options ?? {})
    throw new JudgmentError({
      code: 'internal', phase: 'dispatch', retryable: false,
      message: `连接 "${id}"(${entry.protocol})的协议归一化层尚未实现：等 §13.7 的 P0′ 协议探针结论`,
    })
  }

  /** 远端健康探测。预期失败以 `ok: false` 返回，不抛异常（§13.3 第 4 项）。 */
  async health(options?: HealthOptions): Promise<JudgeHealth> {
    const checkedAt = new Date().toISOString()
    let resolved: ResolvedConnection | undefined
    try {
      resolved = this.resolve(options ?? {})
    } catch (error) {
      return {
        ok: false,
        connection: options?.connection ?? this.config.defaultConnection.get(),
        // 解析都没成功，就没有可断言的协议身份——留空比猜一个诚实。
        protocol: '',
        latencyMs: 0,
        checkedAt,
        failure: failureOf(error),
      }
    }
    return {
      ok: false,
      connection: resolved.id,
      protocol: resolved.entry.protocol,
      model: resolved.entry.model,
      ...(resolved.entry.baseUrl === '' ? {} : { baseUrl: resolved.entry.baseUrl }),
      latencyMs: 0,
      checkedAt,
      failure: {
        code: 'internal', phase: 'dispatch', retryable: false,
        message: '健康探测要真实发包，依赖协议层：等 P0′ 之后接入',
      },
    }
  }
}

export default JudgmentService
