/**
 * 入口 `"."`：组件 `judgment/provider`，注册 `ctx.judgment`。
 *
 * **零工具**（§13.5）——工具面是另一个组件 `judgment/llm-face`，默认关，首版不做。
 * provider 只做四件"单例"事：凭据、多协议归一化、严格校验、审计与计量；加了指纹。
 * 它不观察、不枚举、不寻址、不门控、不做 fallback、不碰 loop（§13.2「绝不」列）。
 *
 * 里程碑：
 * - M2：Service 注册、两层配置解析、`status()`、`fingerprint()`（纯本地）。
 * - M3（当前）：**SystemOne 协议层跑通**——`ask()` / `health()` 真的发包。
 *   线格式来自 §13.7 的 P0′ 探针实测（`provider/system-one.ts` 顶部记了原样固件）。
 *   仍待：严格校验之外的计量/审计 ledger（现在 usage 只在返回值里）、
 *   `openai-decisions`（`predicate`）协议、工具面。
 */

import { type Context } from '@deepseek-ai/cordis'
// Remote：让设置页（客户端半）能调用本 Service 的方法。走 Gateway 的 **运行期 SRC fallback**
// （按 `typertRemote` 绑定 + 装饰器 marker 现推 descriptor），所以**不需要** typert 代码生成。
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// 引用名的权威判据与 brand 都在凭据服务这边——用它，别自己再写一份 grammar。
// （这个 import 同时把 `ctx.credentials` 的类型增补带进来。）
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
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
  JudgmentAnswersFor,
  JudgmentBudget,
  JudgmentPhase,
  JudgmentQuestions,
  JudgmentResult,
  JudgmentState,
  JudgmentTarget,
  JudgmentUsage,
  PurposeStatus,
} from './contract/index.js'
import { Config, type ConnectionConfig, type JudgmentConfig, type QuotaConfig } from './config.js'
import { JudgmentError, failureOf } from './provider/error.js'
import { dispatch } from './provider/dispatch.js'
import { fingerprint as computeFingerprint } from './provider/fingerprint.js'
import { Ledger } from './provider/ledger.js'
import { codecFor, implementedProtocols } from './provider/protocols.js'
import { validateRequest } from './provider/request.js'
import { ResponseRejected, knownUsage, type DecodedUsage } from './provider/wire.js'

export { Config } from './config.js'
export { JudgmentError, isJudgmentError } from './provider/error.js'
export { NORMALIZATION_TOLERANCE, ARGMAX_TOLERANCE } from './provider/wire.js'
export { PROTOCOLS, implementedProtocols } from './provider/protocols.js'
export type { JudgmentConfig, ConnectionConfig, PurposeConfig, Connections, Purposes } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 结构化判断能力。它判断，消费者决定（§13.1）。 */
    judgment: JudgmentService
  }
}

/** 契约版本：与 contract 的 `ApiVersion` 对齐（消费者本地 `EXPECTED` 也写 1）。 */
export const API_VERSION: ApiVersion = 1

/** 状态规模的粗略度量：发出去的状态是成本主变量（§5.1），账上要能看出它有多大。 */
function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/** 这次请求实际用的超时：`budget.maxMs` 在**发包前**生效（只收窄，不放大）。 */
function timeoutOf(configured: number, budget: JudgmentBudget | undefined): number {
  return budget?.maxMs === undefined ? configured : Math.max(1, Math.min(configured, budget.maxMs))
}

/**
 * token 预算只能**事后**比对：发包前不知道端点怎么分词，所以不假装能拦。
 * `maxUsd` 同理——没有价目表就不算，也不编一个数（见 README 的诚实说明）。
 */
function budgetExceeded(budget: JudgmentBudget | undefined, usage: DecodedUsage | undefined): boolean {
  if (budget?.maxTokens === undefined) return false
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) > budget.maxTokens
}

interface ResolvedConnection {
  readonly id: string
  readonly entry: ConnectionConfig
}

export class JudgmentService extends TypertRemoteService implements Judge {
  static inject = ['credentials']
  static Config = Config

  readonly apiVersion: ApiVersion = API_VERSION

  /**
   * 最近一次从凭据服务读到的"是否已设值"快照（`status()` 是同步的，不能做 I/O）。
   * 由 `health()` / `ask()` 刷新；只存布尔，永不存密钥值（§13.2）。
   */
  private readonly credentialPresent = new Map<string, boolean>()

  /** 最近一次 `health()` **成功**的连接 → 时刻（ISO 8601）。`status()` 据此报 `verified`。 */
  private readonly verified = new Map<string, string>()

  /** 审计 ledger（按配置签名缓存：路径或开关一变就换一个实例）。 */
  private ledger: Ledger | undefined
  private ledgerSignature = ''

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

  /** 解析凭据明文。**只在发包这一刻取**，绝不缓存值、绝不写日志（§13.2）。 */
  private async readCredential(ref: string, phase: JudgmentPhase): Promise<string> {
    if (ref === '') {
      throw new JudgmentError({
        code: 'not-configured', phase, retryable: false,
        message: '这条连接没有凭据引用名：请在设置 → 决策里填一次密钥',
      })
    }
    if (!isCredentialRefName(ref)) {
      // 手写配置可能塞进一个不合法的名字；那是配置错误，不是"密钥没设"。
      throw new JudgmentError({
        code: 'not-configured', phase, retryable: false,
        message: `凭据引用名 "${ref}" 不是合法的环境变量名（须匹配 /^[A-Za-z_][A-Za-z0-9_]*$/）`,
      })
    }
    const hit = await this.ctx.credentials.resolve(credentialRef(ref))
    const value = hit?.value
    if (typeof value !== 'string' || value === '') {
      this.credentialPresent.set(ref, false)
      throw new JudgmentError({
        code: 'not-configured', phase, retryable: false,
        message: `凭据 "${ref}" 没有值：在设置里填密钥，或在启动环境里设同名变量`,
      })
    }
    this.credentialPresent.set(ref, true)
    return value
  }

  /**
   * 计量。缺项**不当作 0**：`complete` 明确告知计数是否完整。
   * 网关没有公布价目，所以 `estimatedCostUsd` 省略——**不填 0**（§12.5）。
   */
  private usageOf(usage: DecodedUsage | undefined, latencyMs: number): JudgmentUsage {
    return {
      ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      latencyMs,
      complete: usage?.inputTokens !== undefined && usage?.outputTokens !== undefined,
    }
  }

  /**
   * 本地状态快照（零 I/O）：`configured` 与 `remoteVerified` 分开——
   * "本地显示已配置不代表密钥已验证"（§13.3 第 4 项）。
   */
  /**
   * 暴露给设置页：页面刷新后仍能显示「已验证」（这是 host 内存里的记忆，不是实时探测）。
   * 零参数方法 → 客户端调 `status()` 不传参。
   */
  @Remote
  status(): JudgeStatus {
    const liveConnections = this.config.connections.get()
    const defaultConnection = this.config.defaultConnection.get()
    const connections: ConnectionStatus[] = Object.entries(liveConnections).map(([connection, entry]) => ({
      connection,
      protocol: entry.protocol,
      model: entry.model,
      ...(entry.baseUrl === '' ? {} : { baseUrl: entry.baseUrl }),
      // 引用名为空表示这个连接还没有密钥：省略该字段，而不是报一个空字符串。
      ...(entry.credentialRef === '' ? {} : { credentialRef: entry.credentialRef }),
      credentialPresent: entry.credentialRef !== '' && this.credentialPresent.get(entry.credentialRef) === true,
      verified: this.verified.has(connection),
      ...(this.verified.has(connection) ? { verifiedAt: this.verified.get(connection)! } : {}),
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
      const credentialPresent = target.credentialRef !== '' && this.credentialPresent.get(target.credentialRef) === true
      const usable = target.baseUrl !== '' && credentialPresent
      return {
        purpose,
        connection: id,
        usable,
        // 契约要求 usable 为 false 时必须给出 failure——降级必须显式可见。
        ...(usable ? {} : {
          failure: {
            code: 'not-configured' as const, phase: 'resolve' as const, retryable: false,
            message: target.baseUrl === ''
              ? `连接 "${id}" 没有配置地址`
              : `连接 "${id}" 的凭据尚未确认（status() 零 I/O，先跑一次 health() 或 ask()）`,
          },
        }),
      }
    })

    const configured = connections.length > 0
    return {
      apiVersion: this.apiVersion,
      configured,
      // 远端是否真的通，只能由 health() 的探测回答；这里不猜。
      remoteVerified: this.verified.size > 0,
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
   * 一次批量判断：**恰好一次请求**，不静默重试（重试是消费者的新采样决策，§10.2）。
   *
   * 顺序即纪律：解析 → 请求侧校验（零成本拒绝）→ 指纹 → 取凭据 → 发包 →
   * 响应严格校验（失败即拒，不修复）→ 组装溯源。
   */
  async ask<Q extends JudgmentQuestions>(
    state: JudgmentState,
    questions: Q,
    options?: AskOptions,
  ): Promise<JudgmentResult<Q>> {
    const { id, entry } = this.resolve(options ?? {})

    const invalid = validateRequest(state, questions)
    if (invalid !== undefined) {
      throw new JudgmentError({
        code: 'invalid-request', phase: 'validate-request', retryable: false,
        message: `请求不合规：${invalid.detail}`,
        validation: invalid,
      })
    }
    const codec = codecFor(entry.protocol)
    if (codec === undefined) {
      throw new JudgmentError({
        code: 'internal', phase: 'dispatch', retryable: false,
        message: `协议 "${entry.protocol}" 的归一化层尚未实现（目前只有 ${implementedProtocols().join(' / ')}）`,
      })
    }
    if (entry.baseUrl === '') {
      throw new JudgmentError({
        code: 'not-configured', phase: 'resolve', retryable: false,
        message: `连接 "${id}" 没有配置地址`,
      })
    }

    // 配额检查在**取凭据之前**：配额耗尽是"不该再花一次钱"，不该先读密钥再说。
    await this.assertQuota(id, options?.purpose, entry)

    const fingerprint = computeFingerprint(
      { connection: id, protocol: entry.protocol, baseUrl: entry.baseUrl, model: entry.model },
      state,
      questions,
    )
    const credential = await this.readCredential(entry.credentialRef, 'resolve')

    // 审计：**发包前**先落一条 dispatch，所以"钱花出去了但进程崩了"也留得下痕迹。
    const ledger = this.ledgerFor()
    const attemptId = ledger.newId()
    await ledger.start({
      id: attemptId,
      at: new Date().toISOString(),
      kind: 'ask',
      connection: id,
      protocol: entry.protocol,
      model: entry.model,
      ...(options?.purpose === undefined ? {} : { purpose: options.purpose }),
      fingerprint,
      questionIds: Object.keys(questions),
      stateBytes: byteLength(state),
      ...(options?.budget === undefined ? {} : { budget: options.budget }),
    })

    const started = Date.now()
    let response
    try {
      response = await dispatch({
        url: entry.baseUrl,
        body: codec.encodeBody(entry.model, state, questions),
        credential,
        timeoutMs: timeoutOf(entry.timeoutMs, options?.budget),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      await this.settleFailure(ledger, attemptId, started, error)
      throw error
    }
    const latencyMs = Date.now() - started

    let decoded
    try {
      decoded = codec.decodeResponse(response.body, questions, entry.model)
    } catch (error) {
      if (error instanceof ResponseRejected) {
        // 先映射成**类型化**失败再记账：账上要写 `invalid-response`（+ 校验规则），
        // 而不是把内部的 ResponseRejected 记成 `internal`。
        const rejection = new JudgmentError({
          code: 'invalid-response', phase: 'validate-response', retryable: false,
          message: `响应未通过严格校验：${error.validation.detail}`,
          validation: error.validation,
          fingerprint,
          // 钱已经花了：这次调用的计量必须留住（§12.5 knownUsage 纪律）。
          usage: this.usageOf(knownUsage(response.body), latencyMs),
        })
        await this.settleFailure(ledger, attemptId, started, rejection)
        throw rejection
      }
      await this.settleFailure(ledger, attemptId, started, error)
      throw error
    }

    const usage = this.usageOf(decoded.usage, latencyMs)
    await ledger.settle({
      id: attemptId,
      at: new Date().toISOString(),
      outcome: 'ok',
      latencyMs,
      model: decoded.model,
      ...(decoded.requestId === undefined ? {} : { requestId: decoded.requestId }),
      ...(decoded.usage?.inputTokens === undefined ? {} : { inputTokens: decoded.usage.inputTokens }),
      ...(decoded.usage?.outputTokens === undefined ? {} : { outputTokens: decoded.usage.outputTokens }),
      // token 预算只能事后比（发包前不知道端点怎么分词）；超出的事实要落在账上。
      ...(budgetExceeded(options?.budget, decoded.usage) ? { budgetExceeded: true } : {}),
    })

    return {
      // 运行期集合一致已由 decodeResponse 保证；类型只是把它前移到编译期。
      answers: decoded.answers as JudgmentAnswersFor<Q>,
      fingerprint,
      usage,
      provider: entry.protocol,
      connection: id,
      model: decoded.model,
    }
  }

  /**
   * 逐小时配额检查：**连接层与用途层各自独立，两个都要过**。
   *
   * 配额是成本护栏，不是判断逻辑：耗尽时明确拒绝（`quota-exceeded`，可重试——
   * 窗口滚动后就能过），绝不自作主张换连接或降级到别的模型（§13.6）。
   */
  private async assertQuota(connection: string, purpose: string | undefined, entry: ConnectionConfig): Promise<void> {
    const purposeQuota = purpose === undefined ? undefined : this.config.purposes.get()[purpose]?.quota
    const limited = (quota: QuotaConfig | undefined): boolean =>
      quota !== undefined && (quota.callsPerHour > 0 || quota.inputTokensPerHour > 0)
    if (!limited(entry.quota) && !limited(purposeQuota)) return

    const usage = await this.ledgerFor().usage()
    const check = (key: string, label: string, quota: QuotaConfig | undefined): void => {
      if (quota === undefined || !limited(quota)) return
      const used = usage.get(key) ?? { calls: 0, inputTokens: 0 }
      if (quota.callsPerHour > 0 && used.calls >= quota.callsPerHour) {
        throw new JudgmentError({
          code: 'quota-exceeded', phase: 'resolve', retryable: true,
          message: `${label}这一小时已用满调用配额 ${used.calls}/${quota.callsPerHour}；窗口滚动后可重试`,
        })
      }
      if (quota.inputTokensPerHour > 0 && used.inputTokens >= quota.inputTokensPerHour) {
        throw new JudgmentError({
          code: 'quota-exceeded', phase: 'resolve', retryable: true,
          message: `${label}这一小时已用满输入 token 配额 ${used.inputTokens}/${quota.inputTokensPerHour}；窗口滚动后可重试`,
        })
      }
    }
    check(`connection:${connection}`, `连接 "${connection}"`, entry.quota)
    if (purpose !== undefined) check(`purpose:${purpose}`, `用途 "${purpose}"`, purposeQuota)
  }

  /** ledger 实例按配置缓存（路径/开关变了就换一个）。 */
  private ledgerFor(): Ledger {
    const config = this.config.ledger.get()
    const signature = `${config.enabled ? 'on' : 'off'}:${config.path}`
    if (this.ledger === undefined || this.ledgerSignature !== signature) {
      this.ledger = new Ledger({
        enabled: config.enabled,
        path: config.path,
        logger: { warn: (message) => this.ctx.logger('judgment').warn(message) },
      })
      this.ledgerSignature = signature
    }
    return this.ledger
  }

  /** 失败也要在账上留一笔（含类型化失败的代码与校验规则）。 */
  private async settleFailure(ledger: Ledger, id: string, started: number, error: unknown): Promise<void> {
    const failure = failureOf(error)
    await ledger.settle({
      id,
      at: new Date().toISOString(),
      outcome: 'error',
      latencyMs: Date.now() - started,
      errorCode: failure.code,
      ...(failure.validation === undefined ? {} : { validationRule: failure.validation.rule }),
    })
  }

  /**
   * 远端健康探测：**真发一次最小请求**（一个问题的一句话判断）。
   *
   * 预期失败以 `ok: false` 返回，不抛异常——"已配置"不等于"已验证"，
   * 探测结果是诊断而不是判断失败（§13.3 第 4 项）。
   */
  @Remote
  async health(options?: HealthOptions): Promise<JudgeHealth> {
    const checkedAt = new Date().toISOString()
    let resolved: ResolvedConnection
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

    const { id, entry } = resolved
    const base = {
      connection: id,
      protocol: entry.protocol,
      ...(entry.baseUrl === '' ? {} : { baseUrl: entry.baseUrl }),
    }
    const started = Date.now()

    try {
      const codec = codecFor(entry.protocol)
      if (codec === undefined) {
        throw new JudgmentError({
          code: 'internal', phase: 'dispatch', retryable: false,
          message: `协议 "${entry.protocol}" 的探测尚未实现（目前只有 ${implementedProtocols().join(' / ')}）`,
        })
      }
      if (entry.baseUrl === '') {
        throw new JudgmentError({
          code: 'not-configured', phase: 'resolve', retryable: false,
          message: `连接 "${id}" 没有配置地址`,
        })
      }
      const credential = await this.readCredential(entry.credentialRef, 'resolve')

      // 最小探测：一个问题、一句话的状态。批量经济学在这里不重要，便宜才是（约 30–100 输入 token）。
      const questions = {
        reachable: { kind: 'noul', prompt: '这个判断端点当前可达、凭据有效并正常服务' },
      } as const satisfies JudgmentQuestions

      // 自检**也记账**（合同要求探测受计量与审计约束），但**不受配额阻挡**：
      // 诊断不该被配额挡在门外——它只花一个问题，而且配额耗尽时用户正需要它看原因。
      const ledger = this.ledgerFor()
      const attemptId = ledger.newId()
      await ledger.start({
        id: attemptId,
        at: checkedAt,
        kind: 'health',
        connection: id,
        protocol: entry.protocol,
        model: entry.model,
        questionIds: Object.keys(questions),
        stateBytes: byteLength({ probe: 'dsh-judgment/health' }),
      })

      const response = await dispatch({
        url: entry.baseUrl,
        body: codec.encodeBody(entry.model, { probe: 'dsh-judgment/health' }, questions),
        credential,
        timeoutMs: entry.timeoutMs,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      })
      const latencyMs = Date.now() - started

      let decoded
      try {
        decoded = codec.decodeResponse(response.body, questions, entry.model)
      } catch (error) {
        await this.settleFailure(ledger, attemptId, started, error)
        if (error instanceof ResponseRejected) {
          throw new JudgmentError({
            code: 'invalid-response', phase: 'validate-response', retryable: false,
            message: `探测响应未通过严格校验：${error.validation.detail}`,
            validation: error.validation,
          })
        }
        throw error
      }

      this.verified.set(id, checkedAt)
      await ledger.settle({
        id: attemptId,
        at: new Date().toISOString(),
        outcome: 'ok',
        latencyMs,
        model: decoded.model,
        ...(decoded.requestId === undefined ? {} : { requestId: decoded.requestId }),
        ...(decoded.usage?.inputTokens === undefined ? {} : { inputTokens: decoded.usage.inputTokens }),
        ...(decoded.usage?.outputTokens === undefined ? {} : { outputTokens: decoded.usage.outputTokens }),
      })
      return {
        ok: true,
        ...base,
        // 响应返回的模型快照，不是配置里的别名（§13.4）。
        model: decoded.model,
        latencyMs,
        checkedAt,
        // 这条 ledger 记录的 id：审计里能按它定位到这次探测。
        recordId: attemptId,
        usage: this.usageOf(decoded.usage, latencyMs),
      }
    } catch (error) {
      return {
        ok: false,
        ...base,
        model: entry.model,
        latencyMs: Date.now() - started,
        checkedAt,
        failure: failureOf(error),
      }
    }
  }
}

export default JudgmentService
