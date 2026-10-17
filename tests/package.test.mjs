/**
 * 包清单的纪律测试 —— 只为钉住一次真实事故。
 *
 * 事故：本插件的 peer 依赖里写了
 *   "@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2"      ← 精确版本
 * app 从 0.2.0-rc.2 升到 0.2.1-rc.1 之后，运行中的应用这样判：
 *
 *   { "code": "incompatible-version",
 *     "incompatible": [{ "name": "dsh-judgment", "version": "0.1.0",
 *                        "runtimeVersion": "0.2.1-rc.1",
 *                        "requirements": { "@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2" } }] }
 *
 * 后果不是"少个功能"，而是 **bundle 的 rows 变 0 → 整个插件不被组合**：
 * 设置页消失、host 半不加载，看上去像"插件坏了"。同一份写法还被复制到了新仓库。
 *
 * 所以：host 侧 seam 的 peer 依赖只允许**区间**（`>=` / `^` / `*`），不允许精确版本。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** 精确版本：可选 `v` 前缀 + 纯 semver（含 prerelease），不含任何区间运算符。 */
const EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

test('peer 依赖必须是区间，不能精确钉死（精确钉死会在 app 升版时被判 incompatible-version）', () => {
  const peers = manifest.peerDependencies ?? {}
  const pinned = Object.entries(peers).filter(([, range]) => EXACT.test(String(range)))
  assert.deepEqual(
    pinned,
    [],
    `这些 peer 写成了精确版本，app 升版时会整插件被判 incompatible-version：${JSON.stringify(pinned)}`,
  )
})

test('peer 依赖覆盖我们真正用到的 host 侧 seam', () => {
  const peers = manifest.peerDependencies ?? {}
  for (const name of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/schemastery',
  ]) {
    assert.equal(typeof peers[name], 'string', `缺少 peer：${name}`)
  }
})

test('devDependencies 允许钉精确版本（构建可复现），但版本要与 peer 区间相容', () => {
  const peers = manifest.peerDependencies ?? {}
  const dev = manifest.devDependencies ?? {}
  for (const [name, pinned] of Object.entries(dev)) {
    const range = peers[name]
    if (range === undefined) continue
    // 只做形状检查：dev 的精确版本不能明显违反 peer 的最低要求（例如 peer >=0.2.0 而 dev 是 0.1.x）。
    const floor = /^>=\s*v?(\d+)\.(\d+)\.(\d+)/.exec(range)
    if (floor === null) continue
    // `file:` / `link:` / `workspace:` / git 等是路径或源码 spec，不是版本，不在本测试范围内。
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(pinned)
    if (match === null) continue
    const [major, minor, patch] = match.slice(1).map(Number)
    const [fMajor, fMinor, fPatch] = floor.slice(1).map(Number)
    const atLeast = major > fMajor
      || (major === fMajor && (minor > fMinor || (minor === fMinor && patch >= fPatch)))
    assert.ok(atLeast, `devDependency ${name}@${pinned} 低于 peer 要求 ${range}`)
  }
})
