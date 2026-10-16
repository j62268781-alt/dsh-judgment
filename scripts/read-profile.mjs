/**
 * 本机开发用：从 profile 的 `cordis.patch.yml` 与凭据存储读出**一个连接的运行参数**。
 *
 * 只给 `scripts/` 下的真网脚本用。插件运行期**绝不**这样读凭据——一律通过
 * `ctx.credentials.resolve(ref)` 现取（`src/index.ts` 的 `readCredential`）。
 * 密钥在这里也不会被打印，调用方只拿它放进请求头。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function readConnection(profile = process.env.DSH_PROFILE ?? 'desktop') {
  const patchFile = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
  const patch = readFileSync(patchFile, 'utf8')
  const block = patch.split('- id: judgment/provider')[1]
  if (block === undefined) throw new Error(`${patchFile} 里没有 judgment/provider 这一行`)
  const pick = (name) => {
    const hit = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm').exec(block)
    return hit?.[1]
  }
  const baseUrl = pick('baseUrl')
  const model = pick('model')
  if (baseUrl === undefined || model === undefined) throw new Error('连接缺少 baseUrl / model')
  return {
    profile,
    baseUrl,
    model,
    protocol: pick('protocol') ?? 'system-one',
    credentialRef: pick('credentialRef'),
    timeoutMs: Number(pick('timeoutMs') ?? 10_000),
  }
}

/** 密钥来源：先环境变量，再本机凭据存储。 */
export function readCredential(ref) {
  if (ref === undefined || ref === '') throw new Error('这条连接还没有凭据引用名')
  const fromEnv = process.env[ref]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const storeFile = join(homedir(), '.dsh', '.credentials.yaml')
  const hit = new RegExp(`^\\s*${ref}:\\s*(\\S+)\\s*$`, 'm').exec(readFileSync(storeFile, 'utf8'))
  if (hit === null) throw new Error(`凭据 "${ref}" 既不在环境里，也不在本机凭据存储里`)
  return hit[1]
}
