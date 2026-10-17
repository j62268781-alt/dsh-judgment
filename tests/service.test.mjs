/**
 * Service 层测试：跑在构建产物上，零测试框架依赖。
 *
 * 网络用 `globalThis.fetch` 替身，所以这里验的是**插件的决策逻辑**（解析 → 校验 → 指纹 → 发包 →
 * 严格校验 → 溯源）与错误映射；真实端到端的发包另有 `scripts/probe.mjs`（真 key、真端点）。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import JudgmentService, { API_VERSION, JudgmentError } from '../lib/index.js'

/** 凭据服务替身：`describe` 只回答"是否已设值"，`resolve` 返回值（§13.2）。 */
class Credentials extends Service {
  constructor(ctx) {
    super(ctx, 'credentials')
    this.present = new Map()
  }

  async describe(ref) {
    return { configured: this.present.has(String(ref)) }
  }

  async resolve(ref) {
    const value = this.present.get(String(ref))
    return value === undefined ? undefined : { value, source: 'test' }
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
  // 这个文件测的是决策逻辑，不测 ledger：**关掉落盘**，免得测试往用户 home 里写账。
  // ledger 的落盘/配额/预算另有 tests/ledger.test.mjs（用临时目录）。
  ledger: { enabled: false, path: '' },
}

const NOUL = { answerable: { kind: 'noul', prompt: 'Is this answerable?' } }

/** 端点回的真实响应（P0′ 探针固件，模型名换成本测试配置的那个）。 */
const REPLY = {
  model: 'typesafe/jev-1.13',
  answers: { answerable: { type: 'noul', noul: 0.98 } },
  usage: { input_tokens: 99, output_tokens: 0 },
  request_id: 'req-1',
}

async function service({ config = CONFIG, key = 'sk-test-key' } = {}) {
  const ctx = new Context()
  await ctx.plugin(Credentials)
  // cordis 按类注册；实例从 ctx 取回来（要按引用名预置值）。
  const credentials = ctx.get('credentials')
  const ref = config.connections['typesafe-main']?.credentialRef
  // `key: null` = 这个引用名没有值（不能用 undefined：那会命中默认参数）。
  if (key !== null && ref !== undefined) credentials.present.set(ref, key)
  await ctx.plugin(JudgmentService, config)
  return ctx.get('judgment')
}

/** 替换 fetch 跑一段；拿回调用记录，并在结束后还原。 */
async function withFetch(handler, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(url, init, calls.length)
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/* ─────────────────────────── 注册与状态 ─────────────────────────── */

test('注册 ctx.judgment，并把「已配置」与「已验证」分开', async () => {
  const judge = await service()
  assert.equal(judge.apiVersion, API_VERSION)

  const status = judge.status()
  assert.equal(status.configured, true)
  assert.equal(status.remoteVerified, false, '本地显示已配置不代表远端已验证')
  assert.equal(status.connections.length, 1)
  assert.equal(status.connections[0].verified, false)
  assert.equal(status.connections[0].verifiedAt, undefined)
  // 契约要求：usable 为 false 时必须给出 failure（降级显式可见）。
  assert.equal(status.purposes[0].usable, false)
  assert.equal(status.purposes[0].failure.code, 'not-configured')
  assert.equal(status.failure, undefined)
})

test('未配置任何连接时 status 给出 not-configured（而不是抛错）', async () => {
  const judge = await service({ config: { connections: {}, purposes: {}, defaultConnection: '' } })
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
    config: {
      ...CONFIG,
      connections: {
        'typesafe-main': CONFIG.connections['typesafe-main'],
        'luna-openai': { ...CONFIG.connections['typesafe-main'], model: 'gpt-6-luna' },
      },
    },
  })
  assert.notEqual(two.fingerprint('snapshot a', NOUL, { connection: 'luna-openai' }), first, '连接身份必须进指纹')
})

/* ─────────────────────────── ask：成功路径 ─────────────────────────── */

test('ask 成功：答案 + 溯源齐全，且指纹与执行侧算出的逐字相同', async () => {
  const judge = await service()
  const result = await withFetch(
    () => json(REPLY),
    () => judge.ask('snapshot a', NOUL, { purpose: 'browser.action' }),
  )

  assert.deepEqual(result.answers.answerable, { kind: 'noul', probability: 0.98 })
  assert.equal(result.provider, 'system-one')
  assert.equal(result.connection, 'typesafe-main')
  assert.equal(result.model, 'typesafe/jev-1.13', '记录的是响应返回的模型快照')
  assert.deepEqual(result.usage.inputTokens, 99)
  assert.equal(result.usage.outputTokens, 0)
  assert.equal(result.usage.complete, true)
  assert.equal(result.usage.estimatedCostUsd, undefined, '价目未知就不填 0')
  assert.equal(typeof result.usage.latencyMs, 'number')

  // 不变量 1：动作前能在同一快照上重算出同一个指纹。
  assert.equal(result.fingerprint, judge.fingerprint('snapshot a', NOUL, { purpose: 'browser.action' }))
})

test('ask 的发包形状：POST 端点、Bearer 头、model/state/questions 三件套', async () => {
  const judge = await service()
  await withFetch(
    () => json(REPLY),
    async (calls) => {
      await judge.ask({ task: 'x' }, NOUL, { purpose: 'browser.action' })
      assert.equal(calls.length, 1, '恰好一次请求，不静默重试')
      assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone')
      assert.equal(calls[0].init.method, 'POST')
      assert.equal(calls[0].init.redirect, 'error')
      assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test-key')
      assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        model: 'typesafe/jev-1.13',
        state: { task: 'x' },
        questions: { answerable: { type: 'noul', instructions: 'Is this answerable?' } },
      })
    },
  )
})

/* ─────────────────────────── ask：失败路径 ─────────────────────────── */

test('请求不合规：发包前零成本拒绝（fetch 一次都没调）', async () => {
  const judge = await service()
  await withFetch(
    () => json(REPLY),
    async (calls) => {
      await assert.rejects(
        () => judge.ask('s', { bad: { kind: 'choice', prompt: 'p', options: { only: 'one' } } }, { purpose: 'browser.action' }),
        (error) => error instanceof JudgmentError
          && error.code === 'invalid-request'
          && error.phase === 'validate-request'
          && error.validation.rule === 'choice-arity',
      )
      assert.equal(calls.length, 0, '不合规请求不该花一次往返')
    },
  )
})

test('凭据没有值：not-configured，且不发包', async () => {
  const judge = await service({ key: null })
  await withFetch(
    () => json(REPLY),
    async (calls) => {
      await assert.rejects(
        () => judge.ask('s', NOUL, { purpose: 'browser.action' }),
        (error) => error instanceof JudgmentError && error.code === 'not-configured' && error.phase === 'resolve',
      )
      assert.equal(calls.length, 0)
    },
  )
})

test('未实现的协议：internal（明确拒绝，不假装能用）', async () => {
  const config = {
    ...CONFIG,
    // 契约的 ProtocolId 是开放联合：第三方实现可以自报身份，但没有编解码器就必须明确拒绝。
    connections: { 'third-party': { ...CONFIG.connections['typesafe-main'], protocol: 'any-jev' } },
    purposes: {},
  }
  const judge = await service({ config })
  await withFetch(
    () => json(REPLY),
    async (calls) => {
      await assert.rejects(
        () => judge.ask('s', NOUL, { connection: 'third-party' }),
        (error) => error instanceof JudgmentError
          && error.code === 'internal'
          && /system-one/.test(error.message),
      )
      assert.equal(calls.length, 0)
    },
  )
})

test('已接归一化层的两套协议都在编解码器表里：system-one 与 openai-decisions', async () => {
  const mod = await import('../lib/provider/protocols.js')
  assert.deepEqual(Object.keys(mod.PROTOCOLS).sort(), ['openai-decisions', 'system-one'])
  assert.equal(mod.codecFor('system-one').id, 'system-one')
  assert.equal(mod.codecFor('openai-decisions').id, 'openai-decisions')
  assert.equal(mod.codecFor('any-jev'), undefined)
})

test('HTTP 状态映射：401 → unauthorized、429 → rate-limited、500 → unavailable', async () => {
  const judge = await service()
  const cases = [[401, 'unauthorized', false], [429, 'rate-limited', true], [500, 'unavailable', true], [404, 'unavailable', false]]
  for (const [status, code, retryable] of cases) {
    await withFetch(
      () => json({ error: 'nope' }, status),
      async () => {
        await assert.rejects(
          () => judge.ask('s', NOUL, { purpose: 'browser.action' }),
          (error) => error instanceof JudgmentError && error.code === code && error.retryable === retryable,
          `HTTP ${status} 应映射到 ${code}`,
        )
      },
    )
  }
})

test('超时：以 timeout 失败，且错误信息不带凭据', async () => {
  const config = {
    ...CONFIG,
    connections: { 'typesafe-main': { ...CONFIG.connections['typesafe-main'], timeoutMs: 30 } },
  }
  const judge = await service({ config })
  await withFetch(
    (url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
    async () => {
      await assert.rejects(
        () => judge.ask('s', NOUL, { purpose: 'browser.action' }),
        (error) => error instanceof JudgmentError && error.code === 'timeout' && error.retryable === true,
      )
    },
  )
})

test('响应未通过严格校验：invalid-response + validation 定位，并留住已花的计量', async () => {
  const judge = await service()
  await withFetch(
    () => json({ model: 'typesafe/jev-1.13', answers: { answerable: { type: 'noul', noul: 7 } }, usage: { input_tokens: 42, output_tokens: 0 } }),
    async () => {
      await assert.rejects(
        () => judge.ask('s', NOUL, { purpose: 'browser.action' }),
        (error) => {
          assert.ok(error instanceof JudgmentError)
          assert.equal(error.code, 'invalid-response')
          assert.equal(error.phase, 'validate-response')
          assert.equal(error.validation.rule, 'answer-shape')
          assert.equal(error.validation.questionId, 'answerable')
          assert.equal(error.usage.inputTokens, 42, '拒绝也要留住这次调用已经花掉的钱')
          assert.equal(typeof error.fingerprint, 'string')
          return true
        },
      )
    },
  )
})

test('校验失败的结构化数值穿过 Service：optionCount / sum / tolerance（消费者据此缩候选，不解析文案）', async () => {
  const judge = await service()
  const options = {}
  const probabilities = {}
  for (let index = 0; index < 40; index += 1) {
    options[`o${index}`] = `候选 ${index}`
    probabilities[`o${index}`] = 0.95 / 40
  }
  await withFetch(
    () => json({
      model: 'typesafe/jev-1.13',
      answers: { pick: { type: 'choice', choice: 'o0', confidence: 0.9, probabilities } },
    }),
    async () => {
      await assert.rejects(
        () => judge.ask('s', { pick: { kind: 'choice', prompt: '下一步？', options } }, { purpose: 'browser.action' }),
        (error) => {
          assert.ok(error instanceof JudgmentError)
          assert.equal(error.code, 'invalid-response')
          assert.equal(error.validation.rule, 'distribution-normalized')
          assert.equal(error.validation.questionId, 'pick')
          assert.equal(error.validation.optionCount, 40, '候选规模要能直接用于决定重采规模')
          assert.ok(Math.abs(error.validation.sum - 0.95) < 1e-9)
          assert.equal(error.validation.tolerance, 0.02, '容差随失败一起给出，消费者不用写死')
          return true
        },
      )
    },
  )
})

test('拒绝时把校验数值也记进账：校准能从 ledger 复算，不靠手记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jdg-ledger-'))
  const path = join(dir, 'ledger.jsonl')
  try {
    const judge = await service({ config: { ...CONFIG, ledger: { enabled: true, path } } })
    const options = {}
    const probabilities = {}
    for (let index = 0; index < 40; index += 1) {
      options[`o${index}`] = `候选 ${index}`
      probabilities[`o${index}`] = 0.95 / 40
    }
    await withFetch(
      () => json({
        model: 'typesafe/jev-1.13',
        answers: { pick: { type: 'choice', choice: 'o0', confidence: 0.9, probabilities } },
      }),
      async () => {
        await assert.rejects(
          () => judge.ask('s', { pick: { kind: 'choice', prompt: '下一步？', options } }, { purpose: 'browser.action' }),
          (error) => error.code === 'invalid-response',
        )
      },
    )
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const settled = lines.find((line) => line.event === 'settled')
    assert.equal(settled.errorCode, 'invalid-response')
    assert.equal(settled.validationRule, 'distribution-normalized')
    assert.equal(settled.validationOptionCount, 40, '账上要有候选规模')
    assert.ok(Math.abs(settled.validationSum - 0.95) < 1e-9, '账上要有实测 Σp')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('响应不是 JSON：invalid-response', async () => {
  const judge = await service()
  await withFetch(
    () => new Response('<html>502</html>', { status: 200 }),    async () => {
      await assert.rejects(
        () => judge.ask('s', NOUL, { purpose: 'browser.action' }),
        (error) => error instanceof JudgmentError && error.code === 'invalid-response',
      )
    },
  )
})

test('取消信号：以 cancelled 失败（不是 timeout）', async () => {
  const judge = await service()
  const controller = new AbortController()
  await withFetch(
    (url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
    async () => {
      const pending = judge.ask('s', NOUL, { purpose: 'browser.action', signal: controller.signal })
      controller.abort()
      await assert.rejects(
        () => pending,
        (error) => error instanceof JudgmentError && error.code === 'cancelled' && error.retryable === false,
      )
    },
  )
})

/* ─────────────────────────── health ─────────────────────────── */

test('health 成功：真发一次最小请求，之后 status 的「已验证」翻转', async () => {
  const judge = await service()
  const before = judge.status()
  assert.equal(before.remoteVerified, false)

  const health = await withFetch(
    () => json({ model: 'typesafe/jev-1.13', answers: { reachable: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 30, output_tokens: 0 } }),
    async (calls) => {
      const result = await judge.health({ purpose: 'browser.action' })
      // 探测是最小请求：只有一个问题。
      assert.equal(Object.keys(JSON.parse(calls[0].init.body).questions).length, 1)
      return result
    },
  )

  assert.equal(health.ok, true)
  assert.equal(health.connection, 'typesafe-main')
  assert.equal(health.protocol, 'system-one')
  assert.equal(health.model, 'typesafe/jev-1.13')
  assert.equal(typeof health.latencyMs, 'number')
  assert.match(health.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(health.usage.inputTokens, 30)
  assert.equal(health.failure, undefined)

  const after = judge.status()
  assert.equal(after.remoteVerified, true, '探测成功过才敢说已验证')
  assert.equal(after.connections[0].verified, true)
  assert.equal(after.connections[0].verifiedAt, health.checkedAt)
})

test('health 的预期失败以 ok:false 返回，不抛异常（凭据被拒 / 未配置都在内）', async () => {
  const judge = await service()
  const denied = await withFetch(
    () => json({ error: 'bad key' }, 401),
    () => judge.health({ purpose: 'browser.action' }),
  )
  assert.equal(denied.ok, false)
  assert.equal(denied.failure.code, 'unauthorized')
  assert.equal(denied.connection, 'typesafe-main')
  assert.equal(judge.status().remoteVerified, false, '失败不能把"已验证"点亮')

  const noKey = await service({ key: null })
  const missing = await withFetch(() => json(REPLY), () => noKey.health({ purpose: 'browser.action' }))
  assert.equal(missing.ok, false)
  assert.equal(missing.failure.code, 'not-configured')

  const unconfigured = await service({ config: { connections: {}, purposes: {}, defaultConnection: '' } })
  const none = await unconfigured.health()
  assert.equal(none.ok, false)
  assert.equal(none.failure.code, 'not-configured')
  assert.equal(none.protocol, '', '解析都没成功就不该猜一个协议身份')

  // 对称性：报一个不存在的用途名得到的是 unknown-purpose，而不是 not-configured
  // ——"用途名不存在"必须与"没配连接"区分开（§13.3 第 4 项）。
  const unknown = await unconfigured.health({ purpose: 'browser.action' })
  assert.equal(unknown.failure.code, 'unknown-purpose')
})
