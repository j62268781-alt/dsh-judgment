/**
 * 客户端产物的契约测试：不启动 DSH，用替身 ModuleLoader 和替身宿主 ctx 加载产物。
 *
 * 验证三件事：① 产物调用 `window.__ModuleLoader__.load({id, factory})`；
 * ② factory 返回的模块导出 `inject` / `apply`；③ `apply(ctx)` 注册进 `settings.section`
 * 并把 `ctx.configForms.get(entryId)` 拿到的表单交给页面。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** 宿主的模块表替身：只要能在模块体求值时不抛就够了（页面在这里不会被渲染）。 */
function hostRequire(id) {
  if (id === 'react') {
    return {
      createElement: () => null,
      Fragment: null,
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useMemo: (factory) => factory(),
    }
  }
  return {}
}

async function loadClient() {
  let spec
  globalThis.window = { __ModuleLoader__: { load: (next) => { spec = next } } }
  // 加查询串绕开 ESM 缓存，保证每个用例拿到刚构建的那一份。
  await import(`../lib/client.js?case=${Math.random()}`)
  assert.ok(spec !== undefined, '客户端产物必须调用 window.__ModuleLoader__.load')
  return spec
}

test('产物是 ModuleLoader 交接形状，且导出 inject / apply', async () => {
  const spec = await loadClient()
  assert.equal(spec.id, 'dsh-judgment')
  assert.equal(typeof spec.factory, 'function')
  const module = spec.factory(hostRequire)
  assert.deepEqual(module.inject, ['slots', 'configForms'])
  assert.equal(typeof module.apply, 'function')
})

test('apply 注册 settings.section，并把配置表单交给页面', async () => {
  const spec = await loadClient()
  const module = spec.factory(hostRequire)

  const form = { getSnapshot: () => ({ value: {}, status: 'ready' }) }
  const registered = []
  const ctx = {
    configForms: { get: (entryId) => (entryId === 'judgment/provider' ? form : undefined) },
    slots: {
      inject: (name, run) => {
        assert.equal(name, 'settings.section')
        run()
      },
      register: (registration, Component) => { registered.push({ registration, Component }) },
    },
  }

  module.apply(ctx)

  assert.equal(registered.length, 1)
  const { registration, Component } = registered[0]
  assert.equal(registration.name, 'settings.section')
  assert.equal(registration.id, 'judgment')
  assert.equal(registration.order, 21)
  assert.equal(registration.label(), '决策')
  assert.equal(typeof Component, 'function')

  // 页面拿到的就是那个 entry 的表单，并且知道该用哪个 entry id 写回。
  const face = registration.inject()
  assert.equal(face.form, form)
  assert.equal(face.entryId, 'judgment/provider')
})

test('entry 名对不上时退回包名，页面仍能渲染（只是不可写）', async () => {
  const spec = await loadClient()
  const module = spec.factory(hostRequire)

  const registered = []
  const ctx = {
    configForms: { get: (entryId) => (entryId === 'dsh-judgment' ? { getSnapshot: () => ({ value: {} }) } : undefined) },
    slots: {
      inject: (_name, run) => run(),
      register: (registration, Component) => { registered.push({ registration, Component }) },
    },
  }

  module.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].registration.inject().entryId, 'dsh-judgment')
})
