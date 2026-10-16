/**
 * 配置页纯逻辑测试（不需要 React）：校验镜像 Host 的约束，合并/删除不原地改快照。
 * 这些规则与 src/config.ts 的 schemastery 约束必须一致——漂移会让页面允许
 * 一个 Host 必然拒绝的值，用户只能在保存后看到一句失败。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blankConnection, connectionDraft, connectionStatus, connectionValue, CREDENTIAL_PREFIX, dictOf,
  findForm, keyFieldState, keyStateText, matchesQuery, nextCredentialRef, purposeStatus, purposeTargetLabel,
  purposesUsing, resolveCredentialRef, shouldClearCredential, validateConnection, validateKey,
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
    [{ ...GOOD, name: '---' }, '连接名'],
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

test('connectionValue 去掉空白，并按 schema 的字段收口', () => {
  assert.deepEqual(connectionValue({ ...GOOD, model: ' typesafe/jev-1.13 ', baseUrl: ' https://x/y ' }, 'JUDGMENT_API_KEY_3'), {
    protocol: 'system-one',
    baseUrl: 'https://x/y',
    model: 'typesafe/jev-1.13',
    credentialRef: 'JUDGMENT_API_KEY_3',
    timeoutMs: 10000,
  })
})

test('connectionValue 永远不含密钥值', () => {
  const value = connectionValue({ ...GOOD, key: 'sk-secret-should-not-leak' }, 'JUDGMENT_API_KEY_1')
  assert.equal('key' in value, false)
  assert.equal(JSON.stringify(value).includes('sk-secret-should-not-leak'), false)
})

test('凭据引用名是 JUDGMENT_API_KEY_{序号}，全大写、取最小空号', () => {
  assert.equal(CREDENTIAL_PREFIX, 'JUDGMENT_API_KEY_')
  assert.equal(nextCredentialRef([]), 'JUDGMENT_API_KEY_1')
  assert.equal(nextCredentialRef(['JUDGMENT_API_KEY_1']), 'JUDGMENT_API_KEY_2')
  assert.equal(nextCredentialRef(['JUDGMENT_API_KEY_2']), 'JUDGMENT_API_KEY_1', '空号要回收，编号保持紧凑')
  assert.equal(nextCredentialRef(['JUDGMENT_API_KEY_1', 'JUDGMENT_API_KEY_3']), 'JUDGMENT_API_KEY_2')
  assert.equal(nextCredentialRef(['TYPESAFE_API_KEY']), 'JUDGMENT_API_KEY_1', '别的形状的引用名不占用号')
  assert.match(nextCredentialRef([]), /^JUDGMENT_API_KEY_\d+$/)
})

test('resolveCredentialRef：已存在的不变，新建的拿空号（互不相同）', () => {
  assert.equal(resolveCredentialRef('JUDGMENT_API_KEY_7', []), 'JUDGMENT_API_KEY_7')
  assert.equal(resolveCredentialRef('', []), 'JUDGMENT_API_KEY_1')
  assert.equal(resolveCredentialRef('  ', ['JUDGMENT_API_KEY_1']), 'JUDGMENT_API_KEY_2')
  const first = resolveCredentialRef('', [])
  const second = resolveCredentialRef('', [first])
  assert.notEqual(first, second, '两条连接不能共用一个凭据')
})

test('密钥校验：非空 + 可打印 ASCII（照模型页的判据）', () => {
  assert.equal(validateKey('sk-abc123'), null)
  assert.equal(validateKey('  sk-abc123  '), null)
  assert.ok(validateKey('') !== null)
  assert.ok(validateKey('   ') !== null)
  assert.ok(validateKey('has space') !== null)
  assert.ok(validateKey('line\nbreak') !== null)
  assert.ok(validateKey('中文字符') !== null)
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

test('connectionDraft 从条目还原；密钥框永远是空的（不回显）', () => {
  assert.deepEqual(connectionDraft('main', { protocol: 'openai-decisions', baseUrl: 'u', model: 'm', credentialRef: 'K', timeoutMs: 5 }), {
    name: 'main', protocol: 'openai-decisions', baseUrl: 'u', model: 'm', timeoutMs: 5, key: '',
  })
  assert.deepEqual(connectionDraft('main', undefined), {
    name: 'main', protocol: 'system-one', baseUrl: '', model: '', timeoutMs: 10000, key: '',
  })
})

test('blankConnection 不含 credentialRef（否则每条连接共用同一个凭据）', () => {
  const draft = blankConnection()
  assert.equal('credentialRef' in draft, false)
  assert.deepEqual(draft, {
    name: '', protocol: 'system-one', baseUrl: GOOD.baseUrl, model: GOOD.model, timeoutMs: GOOD.timeoutMs,
    key: '',
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

test('搜索匹配：空查询全命中，命中任一字段即可，大小写不敏感', () => {
  assert.equal(matchesQuery(['typesafe-main', 'https://api.typesafe.ai', 'typesafe/jev-1.13'], ''), true)
  assert.equal(matchesQuery(['typesafe-main'], '  '), true)
  assert.equal(matchesQuery(['typesafe-main', 'https://api.typesafe.ai'], 'TYPESAFE'), true)
  assert.equal(matchesQuery(['mobile.action', 'typesafe-main'], 'action'), true)
  assert.equal(matchesQuery(['mobile.action', 'typesafe-main'], 'browser'), false)
  assert.equal(matchesQuery([null, undefined, 42], '42'), true)
})

test('连接状态：缺哪一项说哪一项；密钥状态另算', () => {
  assert.equal(connectionStatus({ ...GOOD, baseUrl: '' }, undefined).text, '未设地址')
  assert.equal(connectionStatus({ ...GOOD, model: '' }, undefined).text, '未设模型')
  assert.equal(connectionStatus({ ...GOOD, credentialRef: '' }, { configured: true, writable: true }).text, '未设凭据名')
  assert.equal(connectionStatus(GOOD, undefined).text, '配置完整 · 未自检', '状态没读到时不谎报已配置')
  assert.equal(connectionStatus(GOOD, null).text, '读不到密钥状态')
  assert.equal(connectionStatus(GOOD, { configured: false, writable: true }).text, '密钥未配置')
  const stored = connectionStatus(GOOD, { configured: true, writable: true })
  assert.equal(stored.tone, 'ok')
  assert.match(stored.text, /未自检/, '密钥已配置也不等于远端已验证')
  assert.equal(connectionStatus(GOOD, { configured: true, writable: false, source: 'env' }).text, '密钥由环境提供 · 未自检')

  // 自检结论优先于「未自检」：本地配好 ≠ 远端能用，凑齐了也只说"未自检"。
  assert.equal(connectionStatus(GOOD, { configured: true, writable: true }, { ok: true, latencyMs: 42 }).text, '已验证 · 42ms')
  assert.equal(connectionStatus(GOOD, { configured: true, writable: true }, { ok: true }).text, '已验证')
  const failed = connectionStatus(GOOD, { configured: true, writable: true }, { ok: false, message: 'unauthorized · 凭据被拒（HTTP 401）' })
  assert.equal(failed.tone, 'warn')
  assert.match(failed.text, /自检失败：unauthorized/)
  // 本地缺项仍然先报缺项：自检结论不能掩盖"连地址都没填"。
  assert.equal(connectionStatus({ ...GOOD, baseUrl: '' }, undefined, { ok: true, latencyMs: 5 }).text, '未设地址')
})

test('删连接时该不该清凭据：环境提供的（只读）跳过，别挡住删除', () => {
  assert.equal(shouldClearCredential('JUDGMENT_API_KEY_1', { configured: true, writable: true }), true)
  assert.equal(shouldClearCredential('JUDGMENT_API_KEY_1', { configured: false, writable: true }), true)
  assert.equal(shouldClearCredential('JUDGMENT_API_KEY_1', undefined), true, '状态未知时仍尝试清理')
  assert.equal(shouldClearCredential('JUDGMENT_API_KEY_1', { configured: true, writable: false }), false)
  assert.equal(shouldClearCredential('', { configured: true, writable: true }), false)
})

test('密钥输入框：空与已配置是两句不同的话，环境只读时锁住', () => {
  const empty = keyFieldState({ configured: false, writable: true })
  const configured = keyFieldState({ configured: true, writable: true, source: 'stored' })
  const locked = keyFieldState({ configured: true, writable: false, source: 'env' })
  const loading = keyFieldState(undefined)
  const unavailable = keyFieldState(null)

  assert.notEqual(empty.placeholder, configured.placeholder)
  assert.notEqual(empty.hint, configured.hint)
  assert.match(empty.placeholder, /不回显/)
  assert.match(configured.placeholder, /留空/)
  assert.match(configured.hint, /stored/)
  assert.equal(empty.locked, false)
  assert.equal(locked.locked, true, '环境变量提供的密钥不能在这里改')
  assert.match(locked.placeholder, /只读/)
  assert.equal(loading.locked, false)
  assert.equal(unavailable.locked, true)
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

test('密钥那一行只说凭据本身（能不能用属于自检，不混在一起）', () => {
  assert.equal(keyStateText(undefined), '读取中…')
  assert.equal(keyStateText(null), '读不到状态')
  assert.equal(keyStateText({ configured: false, writable: true }), '未配置')
  assert.equal(keyStateText({ configured: true, writable: true }), '已配置')
  assert.equal(keyStateText({ configured: true, writable: false, source: 'env' }), '由环境提供（只读）')
})
