/**
 * 客户端入口（browser half）。
 *
 * 只做一件事：在设置里注册一个 `settings.section` 页面，并把该插件的配置表单交给它。
 * 配置的读写全部走 `ctx.configForms.get(entryId)`——没有 Remote、没有通道，
 * 所以首版客户端不需要 host 侧的任何额外面。
 */
import './react.js'
import { findForm } from './config.js'
import { judgmentContribution } from './judgment-remote.js'
import { primitives } from './primitives.js'
import { Panel } from './panel.jsx'

/** 浏览器侧需要的服务：槽位 + 配置表单 + 凭据读写面（remote.credentials）。 */
export const inject = ['slots', 'configForms', 'remote', 'remote.credentials']

export async function apply(ctx) {
  // entry id 在注册时就解析一次：页面渲染时宿主不会再变。
  const { form, entryId } = findForm(ctx)
  // 凭据面：宿主没提供就退化成只读展示（页面会说明），不让整个客户端半挂掉。
  let credentials
  try {
    credentials = ctx.remote?.credentials
  } catch {
    credentials = undefined
  }
  // Remote：把 host 半的 status()/health() 挂进来，设置页才有「自检」。
  // 必须在注册槽位**之前** mount——页面渲染时那个命名空间就得存在。
  // mount 归调用方 fiber 所有，插件卸载时会自动撤掉。
  //
  // 取命名空间必须用 `ctx.get('remote.judgment')`（**不带 inject 守卫**的取法）：
  // 它是 mount 之后才存在的服务，写进静态 `inject` 会等一个只有我们自己才创建的服务 → 死锁；
  // 而 `ctx.remote.judgment` 这种属性访问会被 cordis 的 inject 守卫拦下
  // （真机报过：`cannot get property "remote.judgment" without inject`）。
  let judgment
  try {
    await ctx.remote.$mount(judgmentContribution())
  } catch (error) {
    // 拿不到就退化成"没有自检通路"，页面其余部分照常可用。
    console.warn('[judgment] Remote $mount 失败，自检按钮将不可用：', error)
  }
  try {
    judgment = ctx.get('remote.judgment')
  } catch (error) {
    judgment = undefined
    console.warn('[judgment] 取 remote.judgment 失败，自检按钮将不可用：', error)
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'judgment',
    order: 21,
    label: () => '决策',
    // primitives 见 client/primitives.js：走宿主模块表的同步 require。
    inject: () => ({ form, entryId, credentials, primitives, judgment }),
  }, Panel))
}
