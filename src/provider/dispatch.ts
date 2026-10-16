/**
 * 一次真实发包。**恰好一次**——provider 不静默重试（"重试 = 新采样"，§10.2），
 * 所以每次调用的计量与审计记录都精确对应一次网络往返。
 *
 * 传输层只负责三件事：超时/取消、HTTP 状态 → 类型化失败、JSON 解析。
 * 线格式与响应校验分别在 `system-one.ts` 与 `request.ts`。
 */

import { JudgmentError } from './error.js'

export interface DispatchInput {
  /** 归一化后的端点（不含凭据、query、hash）。 */
  readonly url: string
  readonly body: unknown
  /** 密钥明文，只进请求头；**永不进错误信息**（§13.2）。 */
  readonly credential: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface DispatchOutput {
  readonly status: number
  readonly body: unknown
  readonly rawText: string
}

/** 防御性脱敏：万一上游把请求头之类回显进错误体，也不能让它漏出去。 */
function redact(text: string, credential: string): string {
  return credential === '' ? text : text.split(credential).join('<redacted>')
}

function excerpt(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}

/** HTTP 状态 → 类型化失败。`retryable` 只表示"重试可能成功"，重试与否属于消费者的循环（§13.2）。 */
function httpFailure(status: number, text: string): JudgmentError {
  const detail = excerpt(text)
  const suffix = detail === '' ? '' : `：${detail}`
  if (status === 400 || status === 422) {
    return new JudgmentError({ code: 'invalid-request', phase: 'dispatch', retryable: false, message: `端点拒绝了这次请求（HTTP ${status}）${suffix}` })
  }
  if (status === 401 || status === 403) {
    return new JudgmentError({ code: 'unauthorized', phase: 'dispatch', retryable: false, message: `凭据被拒（HTTP ${status}）${suffix}` })
  }
  if (status === 404) {
    return new JudgmentError({ code: 'unavailable', phase: 'dispatch', retryable: false, message: `端点不存在（HTTP 404）${suffix}` })
  }
  if (status === 408) {
    return new JudgmentError({ code: 'timeout', phase: 'dispatch', retryable: true, message: `端点超时（HTTP 408）${suffix}` })
  }
  if (status === 429) {
    return new JudgmentError({ code: 'rate-limited', phase: 'dispatch', retryable: true, message: `被限流（HTTP 429）${suffix}` })
  }
  return new JudgmentError({
    code: 'unavailable', phase: 'dispatch', retryable: true,
    message: `端点不可用（HTTP ${status}）${suffix}`,
  })
}

/** 发一封信，拿回状态与 JSON 体；任何失败都抛类型化 `JudgmentError`。 */
export async function dispatch(input: DispatchInput): Promise<DispatchOutput> {
  // 用函数读而不是直接读：否则 TS 的控制流收窄会认为"上面查过了，这里不可能为真"，
  // 而取消完全可能发生在两次读取之间。
  const cancelled = (): boolean => input.signal?.aborted === true

  // 调用方的取消可能在进到这里之前就发生了（解析凭据、校验都要时间）；
  // 不先查一次就会白等一整个超时。
  if (cancelled()) {
    throw new JudgmentError({ code: 'cancelled', phase: 'dispatch', retryable: false, message: '调用被取消' })
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, input.timeoutMs))
  const onAbort = (): void => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })

  let response: Response
  try {
    response = await fetch(input.url, {
      method: 'POST',
      // 不跟随跳转：端点是配置里明确的那一个，跳走就不再是它了。
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${input.credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input.body),
    })
  } catch (cause) {
    // 先看调用方的取消，再看超时：两者都表现为 AbortError。
    if (cancelled()) {
      throw new JudgmentError({ code: 'cancelled', phase: 'dispatch', retryable: false, message: '调用被取消' })
    }
    if (timedOut) {
      throw new JudgmentError({
        code: 'timeout', phase: 'dispatch', retryable: true,
        message: `请求超过 ${input.timeoutMs}ms 未返回`,
      })
    }
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new JudgmentError({
      code: 'unavailable', phase: 'dispatch', retryable: true,
      message: `网络不可达：${redact(detail, input.credential)}`,
    })
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }

  const rawText = await response.text().catch(() => '')
  if (!response.ok) throw httpFailure(response.status, redact(rawText, input.credential))

  let body: unknown
  try {
    body = JSON.parse(rawText)
  } catch {
    throw new JudgmentError({
      code: 'invalid-response', phase: 'validate-response', retryable: false,
      message: '响应不是合法 JSON',
    })
  }
  return { status: response.status, body, rawText }
}
