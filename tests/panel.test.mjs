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

test('页面把连接与用途画成列表', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, { form: fakeForm(VALUE), entryId: 'judgment/provider' }))

  assert.match(html, /Judgment/)
  // 连接卡片：名字、协议标签、副标题、凭据引用
  assert.match(html, /typesafe-main/)
  assert.match(html, /system-one/)
  assert.match(html, /https:\/\/api\.typesafe\.ai\/v1\/systemone/)
  assert.match(html, /typesafe\/jev-1\.13/)
  assert.match(html, /TYPESAFE_API_KEY/)
  // 用途卡片：名字 + 指向的连接
  assert.match(html, /mobile\.action/)
  // 两个分区与默认连接选择器
  assert.match(html, /连接/)
  assert.match(html, /用途/)
  assert.match(html, /默认连接/)
  // 操作入口
  assert.match(html, /新增连接/)
  assert.match(html, /新增用途/)
})

test('空配置给出下一步，而不是空页面', async () => {
  const { Panel } = await loadPanel()
  const html = renderToStaticMarkup(React.createElement(Panel, { form: fakeForm({}), entryId: 'judgment/provider' }))
  assert.match(html, /还没有连接/)
  assert.match(html, /还没有用途/)
  assert.match(html, /共 0 条/)
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
  assert.doesNotMatch(html, /\.smp-/, '不能复用 skills-mcp 面板的类名')
})
