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

/* ─────────────────── 列表：搜索与右侧状态 ─────────────────── */

/** 搜索匹配：任一字段包含子串即命中；空查询全部命中。 */
export function matchesQuery(needles, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return true
  return needles.some((value) => String(value ?? '').toLowerCase().includes(needle))
}

/**
 * 连接的右侧状态。**只根据配置本身判断**——「配置完整」不等于远端可用，
 * 所以措辞留出「未自检」这一档，别让它读起来像"已验证"（§13.3 第 4 项）。
 */
export function connectionStatus(entry) {
  if (String(entry?.baseUrl ?? '') === '') return { tone: 'warn', text: '未设地址' }
  if (String(entry?.model ?? '') === '') return { tone: 'warn', text: '未设模型' }
  if (String(entry?.credentialRef ?? '') === '') return { tone: 'warn', text: '未设凭据引用' }
  return { tone: 'neutral', text: '配置完整 · 未自检' }
}

/** 用途的右侧状态：它最终会落到哪条连接、落不落得到。 */
export function purposeStatus(purpose, connections, defaultConnection) {
  const target = String(purpose?.connection ?? '')
  const resolved = target !== '' ? target : String(defaultConnection ?? '')
  if (resolved === '') return { tone: 'warn', text: '未指向连接' }
  if (connections?.[resolved] === undefined) return { tone: 'danger', text: '连接不存在' }
  return { tone: 'ok', text: target === '' ? '跟随默认连接' : '指向已配置连接' }
}

/** 用途卡片上的标签：它指向哪儿。 */
export function purposeTargetLabel(purpose, defaultConnection) {
  const target = String(purpose?.connection ?? '')
  if (target !== '') return target
  return String(defaultConnection ?? '') === '' ? '无连接' : '默认'
}

/** 哪些用途指向这条连接（删除连接前要讲清楚代价）。 */
export function purposesUsing(purposes, connectionId, defaultConnection) {
  return Object.entries(purposes)
    .filter(([, purpose]) => (purpose?.connection ?? '') === connectionId)
    .map(([name]) => name)
    .concat(defaultConnection === connectionId ? ['（默认连接）'] : [])
}
