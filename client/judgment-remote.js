/**
 * **手写的 Remote contribution**：让设置页（客户端半）能调用 host 半的
 * `ctx.judgment.status()` 与 `ctx.judgment.health()`。
 *
 * 为什么能手写：DSH 的 Gateway 有**运行期 SRC fallback** —— host 侧只要用
 * `TypertRemoteService` + `@Remote` 暴露方法，Gateway 就会在调用时扫 `typertRemote` 绑定
 * 与装饰器 marker 现推 descriptor。所以本插件**不需要** typert/tsdown 代码生成管线
 * （插件是纯 esbuild 客户端 + `tsc` host，这条路上两侧都不用换构建）。
 *
 * ⚠️ **两个必须遵守的约束**（都来自 Gateway 的实现，破坏它们是静默失效）：
 *
 * 1. **`wire` 必须逐字等于 host 方法的形参名**。src 模式下 Gateway 用
 *    `Function.prototype.toString` 解析形参名当 wire 名（`dsh-api-gateway` 的
 *    `methodParameterNames`）。所以 host 半**不能被压缩/改名**——`tsc` 直出没问题，
 *    但以后若给 host 加 minify，这里会静默断掉。
 * 2. **实参个数必须与 `parameters.length` 相等**。零参数的 `status()` 直接调；
 *    带一个可选参的 `health()` 必须显式传（没有选项就传 `undefined`），
 *    否则客户端会抛 `expected 1 argument(s), got 0`。
 *
 * 另外两条实测行为：返回的是**信封**（`{ok:true,value}` / `{ok:false,error}`，resolve 不 reject）；
 * `HealthOptions.signal` **不能过线**（AbortSignal 不是 JSON），所以这里只传 `connection`。
 */

const PACKAGE = 'dsh-judgment'
const SERVICE = 'judgment'

/** 名义 strict codec：客户端只校验 `mode`，不会调用 `create()`（所以它挡不住脏数据，纯为过闸）。 */
function codec(typeSymbol) {
  return { mode: 'strict', typeSymbol, create: () => ({ parse: (value) => value }) }
}

/** 一条方法的 descriptor。`wire` 见文件头第 1 条约束。 */
function descriptor(method, parameters) {
  const endpoint = `${SERVICE}/${method}`
  return {
    id: `${PACKAGE}#${endpoint}`,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({
      name,
      wire: name,
      source: 'json',
      codec: codec(`${PACKAGE}#${endpoint}:${name}`),
    })),
    // 结果原样透传（`JudgeStatus` / `JudgeHealth` 全是 JSON 值）；strip 由 host 侧负责。
    result: { mode: 'src-json' },
  }
}

export function judgmentContribution() {
  return {
    package: PACKAGE,
    descriptors: [
      // host: status()  —— 页面刷新后仍能显示「已验证」
      descriptor('status', []),
      // host: health(options) —— wire 名必须等于形参名 `options`
      descriptor('health', ['options']),
    ],
  }
}
