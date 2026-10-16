/**
 * 读 Host 配置、校验草稿。
 *
 * `form` 是 DSH 设置槽交给我们的一侧（`ctx.configForms.get(entryId)`）：它有
 * `getSnapshot()`（`{ value, status, revision, writable }`）与 `set` / `unset` / `mutate`。
 * 面板的三形态归一化写法直接照抄，免得在页面里到处判空。
 */

/**
 * Host 行 id 的候选：cordis.patch.yml 里的行 id 是 `judgment/provider`，
 * 但也可能是包名。取到哪个就用哪个写回（`mutate` 需要它）。
 */
export const ENTRY_CANDIDATES = ['judgment/provider', 'dsh-judgment']

/** 取配置表单；未提供的 entry 会抛错，所以逐个试。 */
export function findForm(ctx) {
  for (const entryId of ENTRY_CANDIDATES) {
    try {
      const form = ctx?.configForms?.get?.(entryId)
      if (form) return { form, entryId }
    } catch {
      // 这个 entry 没有配置表单：换下一个候选。
    }
  }
  return { form: undefined, entryId: ENTRY_CANDIDATES[0] }
}

/** 设置文档的值；表单未就绪时是 `{}`。 */
export function snapshotOf(form) {
  const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot
  return snapshot?.value ?? snapshot ?? {}
}

/** 表单状态字符串（宿主没说时按 `ready`）。 */
export function statusOf(form) {
  const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot
  return snapshot?.status ?? 'ready'
}

/** 一个字典字段；非字典读成空字典。 */
export function dictOf(value, field) {
  const dict = value?.[field]
  return dict !== null && typeof dict === 'object' && !Array.isArray(dict) ? dict : {}
}

/* ─────────────────── 校验：镜像 Host 的 schemastery 约束 ─────────────────── */

/** 与 src/config.ts 的 BASE_URL 一致：无凭据、无 query、无 hash。 */
export const BASE_URL_PATTERN = /^(?:$|https?:\/\/(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?(?:\/[^?#\s]*)?)$/
/** 与 src/config.ts 的 CREDENTIAL_REF 一致。 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 连接名 / 用途名：字母数字与 . - _。 */
export const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export const PROTOCOLS = [
  ['system-one', 'system-one —— TypeSafe（协议里叫 noul）'],
  ['openai-decisions', 'openai-decisions —— Luna（协议里叫 predicate）'],
]

/** 一条新连接的初值（与 Host 默认值一致，方便直接改一处就能用）。 */
export function blankConnection() {
  return {
    name: '',
    protocol: 'system-one',
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    model: 'typesafe/jev-1.13',
    credentialRef: 'TYPESAFE_API_KEY',
    timeoutMs: 10000,
  }
}

export function connectionDraft(name, entry) {
  return {
    name,
    protocol: entry?.protocol ?? 'system-one',
    baseUrl: entry?.baseUrl ?? '',
    model: entry?.model ?? '',
    credentialRef: entry?.credentialRef ?? '',
    timeoutMs: entry?.timeoutMs ?? 10000,
  }
}

export function blankPurpose() {
  return { name: '', connection: '' }
}

/** 校验连接草稿；可以保存时返回 `null`，否则返回给人看的那句话。 */
export function validateConnection(draft) {
  if (!NAME_PATTERN.test(String(draft.name ?? '').trim())) {
    return '连接名只能用字母、数字和 . - _，且不超过 64 个字符'
  }
  if (!BASE_URL_PATTERN.test(String(draft.baseUrl ?? '').trim())) {
    return '地址必须是 http(s) 且不含凭据、查询串或 # 片段（留空表示尚未配置）'
  }
  if (String(draft.model ?? '').trim() === '' || /\s/.test(String(draft.model))) {
    return '模型名不能为空、不能含空白字符（要 pin 到具体版本，别用 latest 别名）'
  }
  if (!CREDENTIAL_REF_PATTERN.test(String(draft.credentialRef ?? '').trim())) {
    return '凭据引用名只能用字母、数字、下划线，且不以数字开头（例如 TYPESAFE_API_KEY）'
  }
  const timeout = Number(draft.timeoutMs)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) {
    return '超时必须是 1–300000 之间的整数毫秒'
  }
  return null
}

/** 校验用途草稿。 */
export function validatePurpose(draft) {
  if (!NAME_PATTERN.test(String(draft.name ?? '').trim())) {
    return '用途名只能用字母、数字和 . - _，且不超过 64 个字符（例如 mobile.action）'
  }
  return null
}

/** 写进配置的连接值（只保留 schema 认得的字段）。 */
export function connectionValue(draft) {
  return {
    protocol: draft.protocol,
    baseUrl: String(draft.baseUrl ?? '').trim(),
    model: String(draft.model ?? '').trim(),
    credentialRef: String(draft.credentialRef ?? '').trim(),
    timeoutMs: Number(draft.timeoutMs),
  }
}

/** 卡片副标题：一眼看出这条连接指向哪里。 */
export function describeConnection(entry) {
  const baseUrl = String(entry?.baseUrl ?? '') || '（未设地址）'
  const model = String(entry?.model ?? '') || '（未设模型）'
  return `${baseUrl} · ${model}`
}

/** 删除对象的一个键，返回新对象（不原地改快照）。 */
export function withoutKey(dict, key) {
  const next = { ...dict }
  delete next[key]
  return next
}

/** 哪些用途指向这条连接（删除连接前要讲清楚代价）。 */
export function purposesUsing(purposes, connectionId, defaultConnection) {
  return Object.entries(purposes)
    .filter(([, purpose]) => (purpose?.connection ?? '') === connectionId)
    .map(([name]) => name)
    .concat(defaultConnection === connectionId ? ['（默认连接）'] : [])
}
