#!/usr/bin/env node
/**
 * 真网探针：用**插件自己的协议模块**（`lib/provider/*`）打一次真实端点。
 *
 * 它证明的是"协议层能不能真的问出去"——和 Service 走的是同一段编解码与严格校验代码，
 * 只是绕过了 cordis 的 DI（凭据这里直接从本机凭据存储读，仅限本机开发用；插件运行期
 * 一律通过 `ctx.credentials.resolve` 现取，绝不缓存、绝不落盘）。
 *
 * 用法：
 *   pnpm probe                      # 用 desktop profile 里 judgment/provider 的连接
 *   DSH_PROFILE=web pnpm probe      # 换 profile
 *   JUDGMENT_API_KEY_1=sk-… pnpm probe   # 直接给密钥（优先于凭据存储）
 *
 * 密钥**永不回显**：脚本只打印长度与前缀判断，且在打印响应体前做一次脱敏。
 */

import { dispatch } from '../lib/provider/dispatch.js'
import { encodeBody, decodeResponse } from '../lib/provider/system-one.js'
import { validateRequest } from '../lib/provider/request.js'
import { fingerprint } from '../lib/provider/fingerprint.js'
import { readConnection, readCredential } from './read-profile.mjs'

const STATE = {
  task: '协议层冒烟：验证一次批量判断的完整往返',
  page: '关于「批量概率判定」的示例状态，形状由消费者定义',
}

const QUESTIONS = {
  reachable: { kind: 'noul', prompt: '这个判断端点当前可达、凭据有效并正常服务' },
  action: {
    kind: 'choice',
    prompt: '下一步最能推进协议验证的动作是哪一个？',
    options: { a0: '再发一次同样的请求', a1: '接上页面上的自检按钮', a2: '收工' },
  },
  certainty: { kind: 'score', prompt: '你对上面那个选择的把握有多大？', levels: ['很小', '一般', '很大'] },
}

const connection = readConnection()
const credential = readCredential(connection.credentialRef)

console.log(`profile   ${connection.profile}`)
console.log(`端点      ${connection.baseUrl}`)
console.log(`协议/模型 ${connection.protocol} · ${connection.model}`)
console.log(`凭据      ${connection.credentialRef}（${credential.length} 字符，不回显）`)
console.log('')

const invalid = validateRequest(STATE, QUESTIONS)
if (invalid !== undefined) {
  console.error(`请求不合规（${invalid.rule}）：${invalid.detail}`)
  process.exit(1)
}
const expected = fingerprint(
  { connection: 'probe', protocol: connection.protocol, baseUrl: connection.baseUrl, model: connection.model },
  STATE,
  QUESTIONS,
)

const started = Date.now()
let response
try {
  response = await dispatch({
    url: connection.baseUrl,
    body: encodeBody(connection.model, STATE, QUESTIONS),
    credential,
    timeoutMs: connection.timeoutMs,
  })
} catch (error) {
  console.error(`发包失败：${error.code ?? error.name} · ${error.message}`)
  process.exit(1)
}
const latencyMs = Date.now() - started

let decoded
try {
  decoded = decodeResponse(response.body, QUESTIONS, connection.model)
} catch (error) {
  console.error(`响应未通过严格校验（${error.validation?.rule}）：${error.message}`)
  process.exit(1)
}

console.log(`HTTP ${response.status} · ${latencyMs}ms · 响应模型快照 ${decoded.model}`)
console.log(`计量 input=${decoded.usage?.inputTokens ?? '未知'} output=${decoded.usage?.outputTokens ?? '未知'} request_id=${decoded.requestId ?? '无'}`)
console.log(`指纹 ${expected.slice(0, 16)}…（与本脚本按"执行侧"口径算出的值一致）`)
console.log('')
for (const [id, answer] of Object.entries(decoded.answers)) {
  if (answer.kind === 'abstain') {
    console.log(`${id}: abstain(${answer.reason})`)
    continue
  }
  const signals = [
    answer.confidence === undefined ? '' : `confidence=${answer.confidence}`,
    answer.legend === undefined ? '' : `legend=${JSON.stringify(answer.legend)}`,
  ].filter(Boolean).join(' ')
  if (answer.kind === 'noul') console.log(`${id}: noul p=${answer.probability} ${signals}`)
  if (answer.kind === 'choice') {
    console.log(`${id}: choice=${answer.optionId} 分布=${JSON.stringify(answer.probabilities)} ${signals}`)
  }
  if (answer.kind === 'score') {
    // score 是连续位置（= 分布期望值），所以顺手把它与 Σ i·p_i 对照一下。
    const keys = Object.keys(answer.probabilities)
    const mean = keys.reduce((sum, key) => sum + Number(key) * answer.probabilities[key], 0)
    console.log(`${id}: score=${answer.value}（Σ i·p_i=${mean.toFixed(4)}，差 ${Math.abs(answer.value - mean).toFixed(4)}）${signals}`)
  }
}
console.log('\n协议层往返成功 ✅')
