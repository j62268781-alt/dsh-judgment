/**
 * Service 冒烟测试（跑在构建产物上，零测试框架依赖）。
 *
 * 验证 M2 的验收标准：插件真的能注册出 `ctx.judgment`、两层配置解析正确、
 * 降级显式可见（configured ≠ remoteVerified）、未知用途绝不静默换连接、
 * 指纹稳定且与快照绑定。协议层尚未实现，所以 `ask()` 以 `internal` 失败是**当前预期**。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import JudgmentService, { API_VERSION, JudgmentError } from '../lib/index.js'

/** 凭据服务的替身：只回答"是否已设值"，永不返回值（§13.2）。 */
class Credentials extends Service {
  constructor(ctx) {
    super(ctx, 'credentials')
    this.present = new Set()
  }

  async describe(ref) {
    return { configured: this.present.has(ref) }
  }
}

const CONFIG = {
  connections: {
    'typesafe-main': {
      protocol: 'system-one',
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      model: 'typesafe/jev-1.13',
      credentialRef: 'TYPESAFE_API_KEY',
      timeoutMs: 10_000,
    },
  },
  purposes: { 'browser.action': { connection: 'typesafe-main' } },
  defaultConnection: '',
}

const NOUL = { answerable: { kind: 'noul', prompt: 'Is this answerable?' } }

async function service(config = CONFIG) {
  const ctx = new Context()
  await ctx.plugin(Credentials)
  await ctx.plugin(JudgmentService, config)
  return ctx.get('judgment')
}

test('注册 ctx.judgment，并把「已配置」与「已验证」分开', async () => {
  const judge = await service()
  assert.equal(judge.apiVersion, API_VERSION)

  const status = judge.status()
  assert.equal(status.configured, true)
  assert.equal(status.remoteVerified, false, '本地显示已配置不代表远端已验证')
  assert.equal(status.connections.length, 1)
  assert.deepEqual(status.purposes[0], {
    purpose: 'browser.action',
    connection: 'typesafe-main',
    usable: false, // 凭据未经 health 验证前不可用，且绝不静默退化
  })
  assert.equal(status.failure, undefined)
})

test('未配置任何连接时 status 给出 not-configured（而不是抛错）', async () => {
  const judge = await service({ connections: {}, purposes: {}, defaultConnection: '' })
  const status = judge.status()
  assert.equal(status.configured, false)
  assert.equal(status.failure.code, 'not-configured')
  assert.equal(status.connections.length, 0)
})

test('未知用途绝不静默换连接', async () => {
  const judge = await service()
  assert.throws(
    () => judge.fingerprint('snapshot', NOUL, { purpose: 'mobile.action' }),
    (error) => error instanceof JudgmentError && error.code === 'unknown-purpose',
  )
  assert.throws(
    () => judge.fingerprint('snapshot', NOUL, { connection: 'nope' }),
    (error) => error instanceof JudgmentError && error.code === 'unknown-connection',
  )
})

test('指纹：同输入同值、与快照/连接身份绑定、与键序无关', async () => {
  const judge = await service()
  const first = judge.fingerprint('snapshot a', NOUL, { purpose: 'browser.action' })
  assert.equal(judge.fingerprint('snapshot a', NOUL, { purpose: 'browser.action' }), first)
  assert.notEqual(judge.fingerprint('snapshot b', NOUL, { purpose: 'browser.action' }), first)
  assert.notEqual(
    judge.fingerprint('snapshot a', { answerable: NOUL.answerable, extra: { kind: 'noul', prompt: 'x' } }, { purpose: 'browser.action' }),
    first,
  )

  const two = await service({
    ...CONFIG,
    connections: {
      'typesafe-main': CONFIG.connections['typesafe-main'],
      'luna-openai': { ...CONFIG.connections['typesafe-main'], model: 'gpt-6-luna' },
    },
  })
  assert.notEqual(two.fingerprint('snapshot a', NOUL, { connection: 'luna-openai' }), first, '连接身份必须进指纹')
})

test('health 的预期失败以 ok:false 返回，不抛异常', async () => {
  const judge = await service()
  const health = await judge.health({ purpose: 'browser.action' })
  assert.equal(health.ok, false)
  assert.equal(health.connection, 'typesafe-main')
  assert.equal(health.protocol, 'system-one')
  assert.equal(health.failure.code, 'internal', '协议层未实现（等 P0′ 探针）')
})

test('ask 目前以类型化失败拒绝：协议层未实现（等 P0′）', async () => {
  const judge = await service()
  await assert.rejects(
    () => judge.ask('snapshot a', NOUL, { purpose: 'browser.action' }),
    (error) => error instanceof JudgmentError && error.code === 'internal' && error.phase === 'dispatch',
  )
})
