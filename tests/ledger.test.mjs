/**
 * 审计 ledger 与逐小时配额：跑在构建产物上，用**临时目录**（绝不写用户的 home）。
 *
 * 这里钉住四件事：
 * 1. 每次尝试两行（发包前 `dispatch`、回来后 `settled`），且**永不写密钥值**；
 * 2. 配额在**发包前**拦下（连接层与用途层各自独立），并且**跨进程重启仍然算数**；
 * 3. ledger 落盘失败**不阻断判断**（文件写不进去不该不给你判断）；
 * 4. 预算里哪些能在发包前生效（`maxMs`）、哪些只能事后比对（`maxTokens`）。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import JudgmentService, { JudgmentError } from '../lib/index.js'

class Credentials extends Service {
  constructor(ctx) {
    super(ctx, 'credentials')
  }

  async describe() {
    return { configured: true, writable: true }
  }

  async resolve() {
    return { value: 'sk-secret-value-must-not-be-logged', source: 'test' }
  }
}

const REPLY = {
  model: 'typesafe/jev-1.13',
  answers: { answerable: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 99, output_tokens: 0 },
  request_id: 'req-ledger-1',
}

const NOUL = { answerable: { kind: 'noul', prompt: 'Is this answerable?' } }

/** 一套全新的临时环境：返回 judge 与临时目录。 */
async function environment({ quota = {}, purposeQuota = {}, ledger, extra = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jdg-ledger-'))
  const ctx = new Context()
  await ctx.plugin(Credentials)
  await ctx.plugin(JudgmentService, {
    connections: {
      'typesafe-main': {
        protocol: 'system-one',
        baseUrl: 'https://api.typesafe.ai/v1/systemone',
        model: 'typesafe/jev-1.13',
        credentialRef: 'TYPESAFE_API_KEY',
        timeoutMs: 10_000,
        quota,
        ...extra,
      },
    },
    purposes: { 'browser.action': { connection: 'typesafe-main', quota: purposeQuota } },
    defaultConnection: '',
    ledger: ledger ?? { enabled: true, path: join(dir, 'ledger.jsonl') },
  })
  return { judge: ctx.get('judgment'), dir, path: join(dir, 'ledger.jsonl') }
}

/** 替换 fetch；`handler` 拿到调用记录。 */
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

/** 读回 ledger 的每一行。 */
async function lines(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('每次尝试两行：发包前 dispatch、回来后 settled，且**不含密钥值**', async (t) => {
  const { judge, dir, path } = await environment()
  t.after(() => rm(dir, { recursive: true, force: true }))

  await withFetch(() => json(REPLY), () => judge.ask('snapshot', NOUL, { purpose: 'browser.action', budget: { maxTokens: 1000 } }))

  const records = await lines(path)
  assert.equal(records.length, 2)
  const [start, settle] = records
  assert.equal(start.event, 'dispatch')
  assert.equal(settle.event, 'settled')
  assert.equal(start.id, settle.id, '两行靠同一个 id 组成一次尝试')
  assert.equal(start.kind, 'ask')
  assert.equal(start.connection, 'typesafe-main')
  assert.equal(start.protocol, 'system-one')
  assert.equal(start.purpose, 'browser.action')
  assert.equal(typeof start.fingerprint, 'string')
  assert.deepEqual(start.questionIds, ['answerable'])
  assert.ok(start.stateBytes > 0, '状态规模要能看出成本主变量')
  assert.deepEqual(start.budget, { maxTokens: 1000 })

  assert.equal(settle.outcome, 'ok')
  assert.equal(settle.model, 'typesafe/jev-1.13')
  assert.equal(settle.requestId, 'req-ledger-1')
  assert.equal(settle.inputTokens, 99)
  assert.equal(typeof settle.latencyMs, 'number')

  const raw = await readFile(path, 'utf8')
  assert.doesNotMatch(raw, /sk-secret-value/, '账上绝不能出现密钥值')
  assert.doesNotMatch(raw, /Bearer/, '账上也不该出现请求头')
})

test('失败也在账上留一笔：错误码与校验规则都记下来', async (t) => {
  const { judge, dir, path } = await environment()
  t.after(() => rm(dir, { recursive: true, force: true }))

  await withFetch(
    () => json({ model: 'typesafe/jev-1.13', answers: { answerable: { type: 'noul', noul: 5 } }, usage: { input_tokens: 42, output_tokens: 0 } }),
    async () => {
      await assert.rejects(() => judge.ask('s', NOUL, { purpose: 'browser.action' }), (error) => error.code === 'invalid-response')
    },
  )

  const [, settle] = await lines(path)
  assert.equal(settle.outcome, 'error')
  assert.equal(settle.errorCode, 'invalid-response')
  assert.equal(settle.validationRule, 'answer-shape')
})

test('配额在发包前拦下，且连接层与用途层各自独立', async (t) => {
  const { judge, dir, path } = await environment({ quota: { callsPerHour: 2 } })
  t.after(() => rm(dir, { recursive: true, force: true }))

  await withFetch(() => json(REPLY), async (calls) => {
    await judge.ask('s', NOUL, { purpose: 'browser.action' })
    await judge.ask('s', NOUL, { purpose: 'browser.action' })
    assert.equal(calls.length, 2)

    await assert.rejects(
      () => judge.ask('s', NOUL, { purpose: 'browser.action' }),
      (error) => {
        assert.ok(error instanceof JudgmentError)
        assert.equal(error.code, 'quota-exceeded')
        assert.equal(error.phase, 'resolve')
        assert.equal(error.retryable, true, '窗口滚动后就能过，所以是可重试的')
        assert.match(error.message, /2\/2/)
        return true
      },
    )
    assert.equal(calls.length, 2, '被配额拦下的调用不该花一次往返')
  })

  // 用途层配额独立：连接层没满、用途层满了也要拦。
  const scoped = await environment({ purposeQuota: { callsPerHour: 1 } })
  t.after(() => rm(scoped.dir, { recursive: true, force: true }))
  await withFetch(() => json(REPLY), async (calls) => {
    await scoped.judge.ask('s', NOUL, { purpose: 'browser.action' })
    await assert.rejects(
      () => scoped.judge.ask('s', NOUL, { purpose: 'browser.action' }),
      (error) => error.code === 'quota-exceeded' && /用途/.test(error.message),
    )
    assert.equal(calls.length, 1)
  })
  assert.equal((await lines(path)).length, 4, '两次成功各两行；被拦下的那次什么都没写')
})

test('配额跨重启仍然算数：从 ledger 尾部回读计数', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jdg-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'ledger.jsonl')
  const config = (quota) => ({
    connections: {
      main: {
        protocol: 'system-one', baseUrl: 'https://x/y', model: 'm', credentialRef: 'K', timeoutMs: 1000, quota,
      },
    },
    purposes: {},
    defaultConnection: '',
    ledger: { enabled: true, path },
  })

  const first = new Context()
  await first.plugin(Credentials)
  await first.plugin(JudgmentService, config({ callsPerHour: 2 }))
  await withFetch(() => json({ ...REPLY, model: 'm' }), () => first.get('judgment').ask('s', NOUL))

  // 新进程（新 Context、新插件实例）指向同一个 ledger：配额不该归零。
  const second = new Context()
  await second.plugin(Credentials)
  await second.plugin(JudgmentService, config({ callsPerHour: 2 }))
  const judge = second.get('judgment')
  await withFetch(() => json({ ...REPLY, model: 'm' }), async (calls) => {
    await judge.ask('s', NOUL)
    await assert.rejects(
      () => judge.ask('s', NOUL),
      (error) => error.code === 'quota-exceeded' && /1\/2|2\/2/.test(error.message),
    )
    assert.equal(calls.length, 1, '第二次已被回读到的计数拦住')
  })
})

test('ledger 关闭时：不落盘，配额只在进程内算', async (t) => {
  const { judge, dir, path } = await environment({ quota: { callsPerHour: 1 }, ledger: { enabled: false, path: '' } })
  t.after(() => rm(dir, { recursive: true, force: true }))

  await withFetch(() => json(REPLY), async () => {
    await judge.ask('s', NOUL, { purpose: 'browser.action' })
    await assert.rejects(() => judge.ask('s', NOUL, { purpose: 'browser.action' }), (error) => error.code === 'quota-exceeded')
  })
  assert.deepEqual(await lines(path), [], '关掉就一条都不该写')
})

test('ledger 落盘失败不阻断判断（只通过日志说出来）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jdg-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // 拿一个**普通文件**当目录，写入必然失败。
  const blocker = join(dir, 'a-file')
  await writeFile(blocker, 'not a directory', 'utf8')

  const warnings = []
  const ctx = new Context()
  await ctx.plugin(Credentials)
  await ctx.plugin(JudgmentService, {
    connections: {
      main: { protocol: 'system-one', baseUrl: 'https://x/y', model: 'typesafe/jev-1.13', credentialRef: 'K', timeoutMs: 1000, quota: {} },
    },
    purposes: {},
    defaultConnection: '',
    ledger: { enabled: true, path: join(blocker, 'nested', 'ledger.jsonl') },
  })
  // 拦下日志：只关心"说出来了"，不关心输出到哪。
  const originalLogger = ctx.logger
  ctx.logger = (name) => ({ ...originalLogger(name), warn: (message) => warnings.push(message) })

  const judge = ctx.get('judgment')
  const result = await withFetch(() => json(REPLY), () => judge.ask('s', NOUL))
  assert.equal(result.answers.answerable.kind, 'noul', '文件写不进去也必须把答案给你')
  assert.ok(warnings.some((message) => /ledger 写不进去/.test(message)), `应有一条警告，实际：${warnings.join(' | ')}`)
})

test('health 也记账：kind=health，并回传那条 ledger 记录的 id', async (t) => {
  const { judge, dir, path } = await environment()
  t.after(() => rm(dir, { recursive: true, force: true }))

  // 自检问的是 `reachable`，所以要给它那个键的答案（集合必须一致）。
  const health = await withFetch(
    () => json({ model: 'typesafe/jev-1.13', answers: { reachable: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 30, output_tokens: 0 } }),
    () => judge.health({ purpose: 'browser.action' }),
  )
  assert.equal(health.ok, true)
  assert.equal(typeof health.recordId, 'string')

  const records = await lines(path)
  assert.deepEqual(records.map((record) => record.event), ['dispatch', 'settled'])
  assert.equal(records[0].kind, 'health')
  assert.equal(records[0].id, health.recordId)
  assert.equal(records[0].purpose, undefined, '自检不带用途（它是诊断，不是某个用途的判断）')
})

test('预算：`maxMs` 在发包前生效（收窄超时），`maxTokens` 只能事后记在账上', async (t) => {
  const { judge, dir, path } = await environment()
  t.after(() => rm(dir, { recursive: true, force: true }))

  // maxMs 收窄：fetch 永不 resolve，配置超时 10s，预算 40ms → 必须很快以 timeout 失败。
  const started = Date.now()
  await withFetch(
    (url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
    async () => {
      await assert.rejects(
        () => judge.ask('s', NOUL, { purpose: 'browser.action', budget: { maxMs: 40 } }),
        (error) => error.code === 'timeout',
      )
    },
  )
  assert.ok(Date.now() - started < 2000, '预算 40ms 不该等满配置里的 10s')

  // maxTokens 事后比对：响应报 99 input token，预算 1 → 账上标记超出，但答案照常给你。
  const result = await withFetch(
    () => json(REPLY),
    () => judge.ask('s', NOUL, { purpose: 'browser.action', budget: { maxTokens: 1 } }),
  )
  assert.equal(result.answers.answerable.kind, 'noul')
  const settled = (await lines(path)).filter((record) => record.event === 'settled').at(-1)
  assert.equal(settled.budgetExceeded, true, '超出的事实必须落在账上')
})
