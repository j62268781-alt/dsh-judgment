#!/usr/bin/env node
/**
 * 走**真实 Service** 的真网集成：boot 一个最小 cordis 应用，把真 key 喂给凭据服务替身，
 * 然后调用 `ctx.judgment` 的 `ask()` / `health()` / `status()`。
 *
 * 与 `tests/service.test.mjs` 的区别：那里 fetch 是替身（测决策逻辑），这里打的是**真端点**；
 * 与 `scripts/probe.mjs` 的区别：那里直接调协议模块，这里走完整的 Service 接线
 * （用途解析 → 请求校验 → 指纹 → 凭据解析 → 发包 → 严格校验 → 溯源）。
 *
 * 默认不参与 `pnpm test`（测试必须离线可跑）。用法：`pnpm live`
 */

import { Context, Service } from '@deepseek-ai/cordis'
import JudgmentService from '../lib/index.js'
import { readConnection, readCredential } from './read-profile.mjs'

/** 凭据服务替身：返回真 key，但永不打印它。 */
class Credentials extends Service {
  constructor(ctx, key) {
    super(ctx, 'credentials')
    this.key = key
  }

  async describe() {
    return { configured: true, writable: true, source: 'stored' }
  }

  async resolve() {
    return { value: this.key, source: 'stored' }
  }
}

const connection = readConnection()
const credential = readCredential(connection.credentialRef)

const ctx = new Context()
await ctx.plugin(Credentials, credential)
await ctx.plugin(JudgmentService, {
  connections: { live: {
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    model: connection.model,
    credentialRef: connection.credentialRef,
    timeoutMs: connection.timeoutMs,
  } },
  purposes: { 'probe.action': { connection: 'live' } },
  defaultConnection: 'live',
  // **绝不要写进用户的真实账本**：本脚本是开发/校准用的，默认路径是
  // `~/.dsh/judgment-ledger.jsonl`，那是 app 的审计与配额计数所在。
  // 写进去会污染审计（真机账本里曾出现 `live` 这个连接名），也让配额计数失真。
  // 与 `scripts/verify-remote.mjs` 保持一致。
  ledger: { enabled: false, path: '' },
})

const judge = ctx.get('judgment')
const target = { purpose: 'probe.action' }

console.log(`端点 ${connection.baseUrl}`)
console.log(`模型 ${connection.model} · 凭据 ${connection.credentialRef}（${credential.length} 字符，不回显）\n`)

const before = judge.status()
console.log(`status() 探测前  : configured=${before.configured} remoteVerified=${before.remoteVerified} verified=${before.connections[0].verified}`)

const questions = {
  reachable: { kind: 'noul', prompt: '这个判断端点当前可达、凭据有效并正常服务' },
  action: { kind: 'choice', prompt: '下一步最能推进「自检」这件事的是哪个？', options: { a0: '接到页面上', a1: '先跑协议探针', a2: '收工' } },
  certainty: { kind: 'score', prompt: '你对上面那步的把握有多大？', levels: ['很小', '一般', '很大'] },
}

const started = Date.now()
const result = await judge.ask({ task: '真网 integration' }, questions, target)
console.log(`\nask() 返回 · ${Date.now() - started}ms · 响应模型快照 ${result.model}`)
console.log(`溯源 provider=${result.provider} connection=${result.connection} usage input=${result.usage.inputTokens} output=${result.usage.outputTokens} complete=${result.usage.complete}`)
console.log(`指纹 ${result.fingerprint.slice(0, 16)}… 与执行侧重算一致：${result.fingerprint === judge.fingerprint({ task: '真网 integration' }, questions, target)}`)
for (const [id, answer] of Object.entries(result.answers)) {
  if (answer.kind === 'abstain') { console.log(`  ${id}: abstain(${answer.reason})`); continue }
  if (answer.kind === 'noul') console.log(`  ${id}: noul p=${answer.probability}`)
  if (answer.kind === 'choice') console.log(`  ${id}: choice=${answer.optionId} ${JSON.stringify(answer.probabilities)}`)
  if (answer.kind === 'score') {
    const mean = Object.entries(answer.probabilities).reduce((sum, [key, p]) => sum + Number(key) * p, 0)
    console.log(`  ${id}: score=${answer.value}（Σ i·p_i=${mean.toFixed(4)}）`)
  }
}

const health = await judge.health(target)
console.log(`\nhealth() ok=${health.ok} model=${health.model} ${health.latencyMs}ms ${health.failure === undefined ? '' : `failure=${health.failure.code}`}`)

const after = judge.status()
console.log(`status() 探测后  : configured=${after.configured} remoteVerified=${after.remoteVerified} verified=${after.connections[0].verified} verifiedAt=${after.connections[0].verifiedAt ?? '—'}`)
console.log(after.remoteVerified ? '\n「未自检」已翻转成「已验证」✅' : '\n仍未验证 ❌')
