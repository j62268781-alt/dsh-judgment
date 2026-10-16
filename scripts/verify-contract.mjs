/**
 * 强制 contract 的两条模块纪律（§13.9）：
 *   1. 零 import —— 不得 import 任何模块（含 `node:*` 与 provider 内部文件）；
 *   2. 零运行时值 —— 编译产物除注释外不得含任何语句（只允许 `export {}`）。
 *
 * 先 `pnpm build` 再跑本脚本（它检查 `lib/contract` 的产物）。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const SRC = 'src/contract'
const BUILD = 'lib/contract'

/** 去掉块注释与整行注释，剩下的才是真正的代码。 */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const problems = []

for (const file of await readdir(SRC)) {
  if (!file.endsWith('.ts')) continue
  const source = code(await readFile(join(SRC, file), 'utf8'))
  if (/(^|\n)\s*(import\b|export\s+\*|export\s*\{)/.test(source) || /\brequire\s*\(/.test(source)) {
    problems.push(`${SRC}/${file}: contract 不得 import 任何模块`)
  }
}

for (const file of await readdir(BUILD).catch(() => [])) {
  if (!file.endsWith('.js')) continue
  const emitted = code(await readFile(join(BUILD, file), 'utf8')).trim()
  if (emitted !== '' && emitted !== 'export {}' && emitted !== 'export {};') {
    problems.push(`${BUILD}/${file}: 契约产物含运行期语句 → ${emitted.slice(0, 80)}`)
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('contract discipline ok：零 import、零运行时值')
