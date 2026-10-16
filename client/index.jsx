/**
 * 客户端入口（browser half）。
 *
 * 只做一件事：在设置里注册一个 `settings.section` 页面，并把该插件的配置表单交给它。
 * 配置的读写全部走 `ctx.configForms.get(entryId)`——没有 Remote、没有通道，
 * 所以首版客户端不需要 host 侧的任何额外面。
 */
import './react.js'
import { findForm } from './config.js'
import { Panel } from './panel.jsx'

/** 浏览器侧需要的服务：槽位 + 配置表单。 */
export const inject = ['slots', 'configForms']

export function apply(ctx) {
  // entry id 在注册时就解析一次：页面渲染时宿主不会再变。
  const { form, entryId } = findForm(ctx)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'judgment',
    order: 21,
    label: () => 'Judgment',
    inject: () => ({ form, entryId }),
  }, Panel))
}
