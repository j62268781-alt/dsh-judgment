/**
 * 配置页纯逻辑测试（不需要 React）：校验镜像 Host 的约束，合并/删除不原地改快照。
 * 这些规则与 src/config.ts 的 schemastery 约束必须一致——漂移会让页面允许
 * 一个 Host 必然拒绝的值，用户只能在保存后看到一句失败。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blankConnection, connectionDraft, connectionStatus, connectionValue, dictOf, findForm,
  matchesQuery, purposeStatus, purposeTargetLabel, purposesUsing, validateConnection,
  validatePurpose, withoutKey,
} from '../client/config.js'

const GOOD = {
  name: 'typesafe-main',
  protocol: 'system-one',
  baseUrl: 'https://api.typesafe.ai/v1/systemone',
  model: 'typesafe/jev-1.13',
  credentialRef: 'TYPESAFE_API_KEY',
  timeoutMs: 10000,
}

test('合法草稿可以通过校验', () => {
  assert.equal(validateConnection(GOOD), null)
})

test('连接校验挡下 Host 会拒绝的每一种值', () => {
  const cases = [
    [{ ...GOOD, name: '有空格 的名字' }, '连接名'],
    [{ ...GOOD, name: '' }, '连接名'],
    [{ ...GOOD, baseUrl: 'ftp://x' }, '地址'],
    [{ ...GOOD, baseUrl: 'https://user:pass@x/y' }, '地址'],
    [{ ...GOOD, baseUrl: 'https://x/y?q=1' }, '地址'],
    [{ ...GOOD, model: '' }, '模型'],
    [{ ...GOOD, model: 'a b' }, '模型'],
    [{ ...GOOD, credentialRef: '9BAD' }, '凭据引用名'],
    [{ ...GOOD, credentialRef: 'has-dash' }, '凭据引用名'],
    [{ ...GOOD, timeoutMs: 0 }, '超时'],
    [{ ...GOOD, timeoutMs: 300001 }, '超时'],
    [{ ...GOOD, timeoutMs: 1.5 }, '超时'],
  ]
  for (const [draft, expected] of cases) {
    const message = validateConnection(draft)
    assert.ok(message !== null && message.includes(expected), `应拒绝 ${JSON.stringify(draft)}，实际：${message}`)
  }
})

test('空地址是允许的（表示尚未配置）', () => {
  assert.equal(validateConnection({ ...GOOD, baseUrl: '' }), null)
})

test('用途名校验', () => {
  assert.equal(validatePurpose({ name: 'mobile.action', connection: '' }), null)
  assert.ok(validatePurpose({ name: 'bad name' }) !== null)
  assert.ok(validatePurpose({ name: '' }) !== null)
})

test('connectionValue 去掉空白并按 schema 的字段收口', () => {
  assert.deepEqual(connectionValue({ ...GOOD, model: ' typesafe/jev-1.13 ', baseUrl: ' https://x/y ' }), {
    protocol: 'system-one',
    baseUrl: 'https://x/y',
    model: 'typesafe/jev-1.13',
    credentialRef: 'TYPESAFE_API_KEY',
    timeoutMs: 10000,
  })
})

test('withoutKey 不原地改快照', () => {
  const current = { a: { connection: '' }, b: { connection: 'x' } }
  const next = withoutKey(current, 'a')
  assert.deepEqual(Object.keys(current), ['a', 'b'])
  assert.deepEqual(Object.keys(next), ['b'])
})

test('purposesUsing 找出指向该连接的用途（含默认连接）', () => {
  const purposes = { 'a.one': { connection: 'main' }, 'b.two': { connection: 'other' }, 'c.three': { connection: '' } }
  assert.deepEqual(purposesUsing(purposes, 'main', ''), ['a.one'])
  assert.deepEqual(purposesUsing(purposes, 'main', 'main'), ['a.one', '（默认连接）'])
  assert.deepEqual(purposesUsing(purposes, 'unused', ''), [])
})

test('dictOf 只认字典', () => {
  assert.deepEqual(dictOf({ connections: { a: {} } }, 'connections'), { a: {} })
  assert.deepEqual(dictOf({ connections: [] }, 'connections'), {})
  assert.deepEqual(dictOf({}, 'connections'), {})
})

test('connectionDraft 从条目还原，缺字段有兜底', () => {
  assert.deepEqual(connectionDraft('main', { protocol: 'openai-decisions', baseUrl: 'u', model: 'm', credentialRef: 'K', timeoutMs: 5 }), {
    name: 'main', protocol: 'openai-decisions', baseUrl: 'u', model: 'm', credentialRef: 'K', timeoutMs: 5,
  })
  assert.deepEqual(connectionDraft('main', undefined), {
    name: 'main', protocol: 'system-one', baseUrl: '', model: '', credentialRef: '', timeoutMs: 10000,
  })
})

test('findForm 按候选顺序取表单，未提供的 entry 抛错也不影响', () => {
  const form = { getSnapshot: () => ({ value: {} }) }
  const ctx = {
    configForms: {
      get: (entryId) => {
        if (entryId === 'dsh-judgment') return form
        throw new Error('unknown entry')
      },
    },
  }
  assert.deepEqual(findForm(ctx), { form, entryId: 'dsh-judgment' })

  const none = findForm({ configForms: { get: () => undefined } })
  assert.equal(none.form, undefined)
  assert.equal(none.entryId, 'judgment/provider')

  // 宿主没有 configForms 服务时也不炸（页面只读空配置）。
  assert.equal(findForm({}).form, undefined)
})

test('blankConnection 的字段与 Host 默认值一致（只有名字不同）', () => {
  assert.deepEqual(blankConnection(), { ...GOOD, name: '' })
})

test('搜索匹配：空查询全命中，命中任一字段即可，大小写不敏感', () => {
  assert.equal(matchesQuery(['typesafe-main', 'https://api.typesafe.ai', 'typesafe/jev-1.13'], ''), true)
  assert.equal(matchesQuery(['typesafe-main'], '  '), true)
  assert.equal(matchesQuery(['typesafe-main', 'https://api.typesafe.ai'], 'TYPESAFE'), true)
  assert.equal(matchesQuery(['mobile.action', 'typesafe-main'], 'action'), true)
  assert.equal(matchesQuery(['mobile.action', 'typesafe-main'], 'browser'), false)
  assert.equal(matchesQuery([null, undefined, 42], '42'), true)
})

test('连接状态：缺哪一项就说哪一项，配齐也只说「未自检」', () => {
  assert.equal(connectionStatus({ ...GOOD, baseUrl: '' }).text, '未设地址')
  assert.equal(connectionStatus({ ...GOOD, model: '' }).text, '未设模型')
  assert.equal(connectionStatus({ ...GOOD, credentialRef: '' }).text, '未设凭据引用')
  const full = connectionStatus(GOOD)
  assert.equal(full.tone, 'neutral')
  assert.match(full.text, /未自检/, '本地配置完整不等于远端已验证')
})

test('用途状态：指向已配置连接 / 跟随默认 / 连接不存在 / 没得跟', () => {
  const connections = { main: GOOD }
  assert.deepEqual(purposeStatus({ connection: 'main' }, connections, ''), { tone: 'ok', text: '指向已配置连接' })
  assert.deepEqual(purposeStatus({ connection: '' }, connections, 'main'), { tone: 'ok', text: '跟随默认连接' })
  assert.equal(purposeStatus({ connection: 'gone' }, connections, '').tone, 'danger')
  assert.equal(purposeStatus({ connection: 'gone' }, connections, '').text, '连接不存在')
  assert.equal(purposeStatus({ connection: '' }, connections, '').tone, 'warn')
  assert.equal(purposeStatus({ connection: '' }, connections, '').text, '未指向连接')
})

test('用途标签：指向哪儿，或「默认」/「无连接」', () => {
  assert.equal(purposeTargetLabel({ connection: 'main' }, ''), 'main')
  assert.equal(purposeTargetLabel({ connection: '' }, 'main'), '默认')
  assert.equal(purposeTargetLabel({ connection: '' }, ''), '无连接')
})
