#!/usr/bin/env node
/**
 * 验证 **Remote 通路**（设置页「自检」按钮靠它）——两端都用**本插件自己的产物**，
 * 不碰运行中的应用，也不需要 typert 代码生成：
 *
 * - **host 半**：真 `dsh-typert-registry` host + `dsh-api-gateway` host + 本插件 `lib/index.js`。
 *   Gateway 走 **SRC fallback**：扫 `typertRemote` 绑定 + 读 `@Remote` 装饰器 marker 现推 descriptor。
 *   所以这一步同时在验证"我们的装饰器与基类接对了"。
 * - **client 半**：真 Gateway client + 本插件 `client/judgment-remote.js` 的手写 contribution。
 *   验证它过得了客户端校验、发出正确的 wire 调用、并且 `$mount`/dispose 生命周期干净。
 * - **交叉验证**：把客户端**实际发出的 args** 原样交给 host 的 `invokeRpc`。
 *     `wire` 名或实参个数只要错一个，这一段就会炸——这是这个脚本存在的核心理由。
 *
 * 离线运行（host 侧的 fetch 被替身接住）。用法：`pnpm verify:remote`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = process.env.DSH_APP_RUNTIME ?? '/Users/joeson/.dsh/app-runtime/node_modules/@deepseek-ai'
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ───────────────────────── host 半 ───────────────────────── */

const cordis = await import(`${APP}/cordis/lib/index.js`)
const { default: TypertRegistry } = await import(`${APP}/dsh-typert-registry/lib/index.js`)
const { default: TypertGatewayService } = await import(`${APP}/dsh-api-gateway/lib/index.js`)
const { default: JudgmentService } = await import(`${REPO}/lib/index.js`)

/** 凭据服务替身：只回答"有值"，且永不打印它。 */
class Credentials extends cordis.Service {
  constructor(ctx) {
    super(ctx, 'credentials')
  }

  async describe() {
    return { configured: true, writable: true, source: 'stored' }
  }

  async resolve() {
    return { value: 'sk-remote-verify-not-a-real-key', source: 'stored' }
  }
}

// 端点用替身接住：这一步验的是 Remote 通路，不是网络。
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response(JSON.stringify({
  model: 'typesafe/jev-1.13',
  answers: { reachable: { type: 'noul', noul: 0.99 } },
  usage: { input_tokens: 31, output_tokens: 0 },
  request_id: 'req-verify-remote',
}), { status: 200, headers: { 'content-type': 'application/json' } })

const hostCtx = new cordis.Context()
hostCtx.plugin(TypertRegistry)
hostCtx.plugin(TypertGatewayService)
hostCtx.plugin(Credentials)
hostCtx.plugin(JudgmentService, {
  connections: {
    live: { protocol: 'system-one', baseUrl: 'https://api.typesafe.ai/v1/systemone', model: 'typesafe/jev-1.13', credentialRef: 'TYPESAFE_API_KEY', timeoutMs: 5000, quota: {} },
  },
  purposes: {},
  defaultConnection: '',
  ledger: { enabled: false, path: '' },
})
await new Promise((resolve) => setTimeout(resolve, 200))

console.log('host 半（SRC fallback 推 descriptor）')
check('typert / typertGateway / judgment 三个服务都在', Boolean(hostCtx.get('typert') && hostCtx.get('typertGateway') && hostCtx.get('judgment')))

const statusCall = await hostCtx.typertGateway.invokeRpc('judgment/status', { args: {} }, undefined, undefined)
check('judgment/status 可按 @Remote 暴露并被调用', statusCall?.ok === true, JSON.stringify(statusCall)?.slice(0, 200))
check('status 的返回值是可判读的本地状态', statusCall?.value?.apiVersion === 1 && statusCall.value.connections?.length === 1)

const healthCall = await hostCtx.typertGateway.invokeRpc('judgment/health', { args: { options: { connection: 'live' } } }, undefined, undefined)
check('judgment/health 走完整探测（替身端点）', healthCall?.ok === true && healthCall.value?.ok === true, JSON.stringify(healthCall)?.slice(0, 240))
check('探测回传模型快照与 recordId', healthCall?.value?.model === 'typesafe/jev-1.13' && typeof healthCall.value?.recordId === 'string')

const unmarked = await hostCtx.typertGateway.invokeRpc('judgment/ask', { args: {} }, undefined, undefined)
check('未标 @Remote 的 ask 不会被暴露', unmarked?.ok === false, JSON.stringify(unmarked)?.slice(0, 160))

const extra = await hostCtx.typertGateway.invokeRpc('judgment/health', { args: { options: {}, bogus: 1 } }, undefined, undefined)
check('多余的 args 键被 host 拒绝', extra?.ok === false, JSON.stringify(extra)?.slice(0, 160))

/* ───────────────────────── client 半 ───────────────────────── */

const registry = new Map()
globalThis.window = { __ModuleLoader__: { load({ id, factory }) { registry.set(id, factory) } } }
globalThis.document = { baseURI: 'http://127.0.0.1:19387/' }
globalThis.WebSocket = class { constructor() {} close() {} addEventListener() {} removeEventListener() {} send() {} }
const evaluate = (file) => { new Function(readFileSync(file, 'utf8'))() }
evaluate(`${APP}/dsh-typert-registry/lib/client.js`)
evaluate(`${APP}/dsh-api-gateway/lib/client.js`)

const wires = []
const connection = {
  isLoopback: true,
  generation: { getSnapshot: () => ({ host: { home: '/tmp' } }) },
  registerGenerationSource: () => () => {},
  rpc: {
    open: undefined,
    call: async (mount, endpoint, payload) => {
      wires.push({ mount, endpoint, args: payload.args })
      return { ok: true, value: { ok: true, connection: 'live', protocol: 'system-one', model: 'typesafe/jev-1.13', latencyMs: 12, checkedAt: new Date().toISOString(), recordId: 'rec-1' } }
    },
  },
  start: () => ({ stop() {} }),
}

const clientCtx = new cordis.Context()
clientCtx.provide('connection', connection)
registry.get('@deepseek-ai/dsh-typert-registry')((id) => {
  if (id === '@deepseek-ai/cordis') return cordis
  throw new Error(id)
}).apply(clientCtx)
registry.get('@deepseek-ai/dsh-api-gateway')((id) => {
  if (id === '@deepseek-ai/cordis') return cordis
  throw new Error(id)
}).apply(clientCtx)

const { judgmentContribution } = await import(`${REPO}/client/judgment-remote.js`)

console.log('\nclient 半（手写 contribution 过 GateWay 校验）')
const dispose = await clientCtx.remote.$mount(judgmentContribution())
check('$mount 成功并返回 disposer', typeof dispose === 'function')
check('命名空间暴露了 status 与 health', typeof clientCtx.remote.judgment?.status === 'function' && typeof clientCtx.remote.judgment?.health === 'function')

const clientStatus = await clientCtx.remote.judgment.status()
check('客户端调用 status() 拿到信封', clientStatus?.ok === true)
check('客户端发出的 status wire 调用零实参', JSON.stringify(wires.at(-1)?.args) === '{}', JSON.stringify(wires.at(-1)))

const clientHealth = await clientCtx.remote.judgment.health({ connection: 'live' })
check('客户端调用 health() 拿到信封', clientHealth?.ok === true)
const healthWire = wires.at(-1)
check('health 的 wire 名是 options', JSON.stringify(Object.keys(healthWire.args)) === '["options"]', JSON.stringify(healthWire.args))

let zeroArgsMessage = ''
try {
  await clientCtx.remote.judgment.health()
} catch (error) {
  zeroArgsMessage = String(error?.message ?? error)
}
check('漏传可选实参会被客户端拦下（说明必须显式传）', /expected 1 argument/.test(zeroArgsMessage), zeroArgsMessage)

/* ─────────────── 交叉验证：客户端发出的 args 原样喂给 host ─────────────── */

console.log('\n交叉验证（两端线契约必须逐字一致）')
const piped = await hostCtx.typertGateway.invokeRpc('judgment/health', { args: healthWire.args }, undefined, undefined)
check('客户端 args 能被 host 直接接受', piped?.ok === true, JSON.stringify(piped)?.slice(0, 200))
check('喂进去的那次真的走到了探测', piped?.value?.ok === true)

await dispose()
check('dispose 之后命名空间消失', clientCtx.remote?.judgment === undefined)

globalThis.fetch = realFetch

console.log('')
if (failures.length === 0) {
  console.log('Remote 通路验证通过 ✅')
  process.exit(0)
}
console.log(`Remote 通路验证失败 ❌（${failures.length} 项）`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
