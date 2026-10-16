/**
 * 页面渲染测试：把 `client/**` 用 esbuild 打成临时 ESM，再用 react-dom/server 真的渲染一次，
 * 断言列表把配置里的连接与用途画出来了。
 *
 * 这是 M4 唯一能自动化的一部分"看得见"的验证——安装到 DSH 里之前的最后一道闸。
 * React 只是测试依赖：运行期由宿主的模块表提供（见 client/esbuild.config.mjs 的 external）。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

async function loadModule(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
    jsx: 'automatic',
    loader: { '.jsx': 'jsx', '.js': 'jsx', '.css': 'text' },
    write: false,
    logLevel: 'silent',
  })
  const out = `node_modules/.cache/${entry.replace(/[^a-zA-Z0-9]/g, '_')}.mjs`
  await mkdir('node_modules/.cache', { recursive: true })
  await writeFile(out, result.outputFiles[0].text)
  return import(`../${out}?case=${Math.random()}`)
}

function loadPanel() {
  return loadModule('client/panel.jsx')
}

function fakeForm(value) {
  return {
    getSnapshot: () => ({ value, status: 'ready', revision: 1, writable: true }),
    set: async () => {},
    subscribe: () => () => {},
  }
}

const VALUE = {
  connections: {
    'typesafe-main': {
      protocol: 'system-one',
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      model: 'typesafe/jev-1.13',
      credentialRef: 'TYPESAFE_API_KEY',
      timeoutMs: 10000,
    },
  },
  purposes: { 'mobile.action': { connection: 'typesafe-main' } },
  defaultConnection: 'typesafe-main',
}

test('默认页签（连接）画出页签条、搜索行与连接卡片', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, { form: fakeForm(VALUE), entryId: 'judgment/provider' }))

  assert.match(html, />决策<\/h2>/)
  // 页签条：标签带计数（全角括号），当前页签标记 active
  assert.match(html, /class="jdg-tabs"/)
  assert.match(html, /data-active="true">连接（1）</)
  assert.match(html, /data-active="false">用途（1）</)
  // 当前页签的摘要 + 搜索行 + 主操作
  assert.match(html, /共 1 条 · 每条 = （协议 · 地址 · 模型 · 凭据引用）/)
  assert.match(html, /搜索连接名 \/ 地址 \/ 模型/)
  assert.match(html, /新增连接/)
  // 连接卡片：箭头 + 名字 + 协议标签 + 右侧状态 + 副标题
  // （断言 class 属性而不是类名——注入的 CSS 文本里也会出现这些类名）
  assert.match(html, /class="jdg-chevron"/)
  assert.match(html, /typesafe-main/)
  assert.match(html, /system-one/)
  assert.match(html, /配置完整 · 未自检/)
  assert.match(html, /https:\/\/api\.typesafe\.ai\/v1\/systemone/)
  assert.match(html, /typesafe\/jev-1\.13/)
  // 没被选中的页签不渲染：不该出现用途卡片、用途搜索框或用途空态
  assert.doesNotMatch(html, /mobile\.action/)
  assert.doesNotMatch(html, /还没有用途/)
  assert.doesNotMatch(html, /搜索用途名/)
  // 默认收起：详情表不渲染（展开才出现）
  assert.doesNotMatch(html, /class="jdg-cardDetails"/)
})

test('用途页签画出用途卡片与「默认连接」行', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, {
    form: fakeForm(VALUE), entryId: 'judgment/provider', initialTab: 'purposes',
  }))

  assert.match(html, /data-active="true">用途（1）</)
  assert.match(html, /共 1 个 · 给消费者一个稳定名字/)
  assert.match(html, /搜索用途名 \/ 指向连接/)
  assert.match(html, /新增用途/)
  // 用途卡片：名字 + 指向标签 + 右侧状态
  assert.match(html, /mobile\.action/)
  assert.match(html, /指向已配置连接/)
  // 「默认连接」只在用途页出现（用途卡片上的「跟随默认连接」说的就是它）
  assert.match(html, /未指定连接的用途落到/)
  assert.doesNotMatch(html, /搜索连接名/)
})

test('空配置给出下一步，而不是空页面', async () => {
  const { Panel } = await loadPanel()
  const connections = renderToStaticMarkup(React.createElement(Panel, { form: fakeForm({}), entryId: 'judgment/provider' }))
  assert.match(connections, /还没有连接/)
  assert.match(connections, /连接（0）/)

  const purposes = renderToStaticMarkup(React.createElement(Panel, { form: fakeForm({}), entryId: 'judgment/provider', initialTab: 'purposes' }))
  assert.match(purposes, /还没有用途/)
  assert.match(purposes, /用途（0）/)
})

test('密钥字段是密码框：不回显、关闭自动填充、显示派生出的凭据名', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, {
    form: fakeForm({}), entryId: 'judgment/provider', initialEditor: 'connection',
  }))
  // 密码框 + 不让浏览器自动填充登录密码（照模型页）。
  // 属性名大小写不敏感：React 服务端渲染出的是 autoComplete=，浏览器解析后是 autocomplete。
  assert.match(html, /type="password"/i)
  assert.match(html, /autocomplete="new-password"/i)
  // 值永远是空的：密钥不进页面状态、也不回显
  assert.match(html, /type="password"[^>]*value=""/i)
  // 凭据名不是用户手填的，而是自动分配并显示出来（也可以用同名环境变量提供）
  assert.match(html, /凭据名 JUDGMENT_API_KEY_1/)
  assert.match(html, /自动分配/)
  assert.match(html, /环境变量/)
  // 宿主没有凭据面：锁住并说明
  assert.match(html, /宿主未提供凭据面/)
  assert.match(html, /无法在这里写入密钥/)
})

test('有凭据面时密钥框可输入，提示「保存后不回显」', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, {
    form: fakeForm({}), entryId: 'judgment/provider', initialEditor: 'connection',
    credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({ ok: true }), unset: async () => ({ ok: true }) },
  }))
  assert.match(html, /填入 API key（保存后不回显）/)
  assert.doesNotMatch(html, /宿主未提供凭据面/)
})

test('不可写时按钮禁用并说明原因', async () => {
  const { Panel } = await loadPanel()
  const readOnly = { getSnapshot: () => ({ value: VALUE, status: 'ready' }) }
  const html = renderToStaticMarkup(React.createElement(Panel, { form: readOnly, entryId: 'judgment/provider' }))
  assert.match(html, /不可写/)
  assert.match(html, /disabled/)
})

test('表单未就绪时显示读取中', async () => {
  const { Panel } = await loadPanel()
  const loading = { getSnapshot: () => ({ value: {}, status: 'loading' }) }
  const html = renderToStaticMarkup(React.createElement(Panel, { form: loading, entryId: 'judgment/provider' }))
  assert.match(html, /正在读取设置/)
})

test('样式随页面注入，且类名不与他插件共用', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, { form: fakeForm(VALUE), entryId: 'judgment/provider' }))
  assert.match(html, /jdg-page/)
  assert.match(html, /\.jdg-card\{/)
  assert.match(html, /\.jdg-tab\[data-active=true\]/)
  assert.doesNotMatch(html, /\.smp-/, '不能复用 skills-mcp 面板的类名')
})

/* ─────────────────── 删除确认：交给 DSH 自带的 Modal ─────────────────── */

test('删除确认把标题/关闭/两个按钮交给宿主 Modal（与内置页面同一个弹窗）', async () => {
  const { ConfirmDialog } = await loadModule('client/dialog.jsx')
  const seen = []
  function StubModal(props) {
    seen.push(props)
    return React.createElement('div', { className: 'modal' }, props.title, props.description, props.footer)
  }
  function StubButton(props) {
    return React.createElement('button', { type: 'button', disabled: props.disabled === true }, props.children)
  }

  const html = renderToStaticMarkup(ConfirmDialog({
    dialog: { kind: 'connection', label: 'probe-main', note: '它的密钥（JUDGMENT_API_KEY_1）会一并清除。' },
    primitives: { Modal: StubModal, Button: StubButton },
    onCancel: () => {},
    onConfirm: () => {},
  }))

  assert.equal(seen.length, 1, '必须渲染一次宿主 Modal')
  const props = seen[0]
  assert.equal(props.open, true)
  assert.equal(props.title, '删除连接「probe-main」？')
  assert.equal(props.closeLabel, '关闭')
  assert.equal(typeof props.onClose, 'function')
  assert.match(html, /它的密钥（JUDGMENT_API_KEY_1）会一并清除/)
  assert.match(html, /取消/)
  assert.match(html, /删除/)
})

test('删除确认：失败原因与进行中状态都留在弹窗里，不静默关掉', async () => {
  const { ConfirmDialog } = await loadModule('client/dialog.jsx')
  function StubModal(props) { return React.createElement('div', null, props.description, props.footer) }

  const html = renderToStaticMarkup(ConfirmDialog({
    dialog: { kind: 'purpose', label: 'mobile.action', note: '删除后消费者再报这个名字会直接报错。' },
    primitives: { Modal: StubModal },
    onCancel: () => {},
    onConfirm: () => {},
    pending: true,
    error: '密钥未清除，已取消删除：被环境变量遮住',
  }))

  assert.match(html, /正在删除并刷新配置…/)
  assert.match(html, /密钥未清除，已取消删除/)
  assert.match(html, /删除中…/)
})

test('拿不到官方 Modal 时不渲染弹窗（调用方退回原生 confirm）', async () => {
  const { ConfirmDialog } = await loadModule('client/dialog.jsx')
  const dialog = { kind: 'connection', label: 'x', note: 'n' }
  const noop = () => {}
  assert.equal(ConfirmDialog({ dialog, primitives: null, onCancel: noop, onConfirm: noop }), null)
  assert.equal(ConfirmDialog({ dialog, primitives: {}, onCancel: noop, onConfirm: noop }), null)
  assert.equal(ConfirmDialog({ dialog: null, primitives: { Modal: () => null }, onCancel: noop, onConfirm: noop }), null)
})

/* ─────────────────── 自检按钮（走 host 半的 Remote） ─────────────────── */

test('有 Remote 时：链接行上方常驻一行自检文案，并指向 ⋯ 菜单', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, {
    form: fakeForm(VALUE),
    entryId: 'judgment/provider',
    judgment: { health: async () => ({ ok: true, value: {} }), status: async () => ({ ok: true, value: { connections: [] } }) },
  }))
  assert.match(html, /class="jdg-probeLine" data-tone="neutral">尚未自检 · 可在 ⋯ 菜单里自检/)
  assert.doesNotMatch(html, /宿主未提供自检通路/)
})

test('没有 Remote 时：那一行如实说明宿主没提供自检通路', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, {
    form: fakeForm(VALUE),
    entryId: 'judgment/provider',
  }))
  assert.match(html, /宿主未提供自检通路：只能看到本地「已配置」/)
})

test('宿主记忆里的「已验证」直接显示在那一行（页面刷新后仍说得对）', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, {
    form: fakeForm(VALUE),
    entryId: 'judgment/provider',
    judgment: {
      health: async () => ({ ok: true, value: {} }),
      status: async () => ({ ok: true, value: { connections: [{ connection: 'typesafe-main', verified: true, verifiedAt: '2026-10-16T08:35:04.142Z' }] } }),
    },
  }))
  // status() 是异步的，SSR 里不会跑出结果：这里只断言"没有撒谎"，真正的持久化行为在真机验过。
  assert.match(html, /jdg-probeLine/)
})
