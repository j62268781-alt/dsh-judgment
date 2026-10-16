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

const BUNDLE = 'node_modules/.cache/jdg-panel.test.mjs'

async function loadPanel() {
  const result = await build({
    entryPoints: ['client/panel.jsx'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    jsx: 'automatic',
    loader: { '.jsx': 'jsx', '.js': 'jsx', '.css': 'text' },
    write: false,
    logLevel: 'silent',
  })
  await mkdir('node_modules/.cache', { recursive: true })
  await writeFile(BUNDLE, result.outputFiles[0].text)
  return import(`../${BUNDLE}?case=${Math.random()}`)
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
