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
/** 与 src/config.ts 的 CREDENTIAL_REF 一致；空字符串表示尚未配置（引用名是按连接名派生的）。 */
export const CREDENTIAL_REF_PATTERN = /^(?:$|[A-Za-z_][A-Za-z0-9_]*)$/
/** 连接名 / 用途名：字母数字与 . - _。 */
export const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export const PROTOCOLS = [
  ['system-one', 'system-one —— TypeSafe（协议里叫 noul）'],
  ['openai-decisions', 'openai-decisions —— Luna（协议里叫 predicate）'],
]

/**
 * 一条新连接的初值。
 *
 * `credentialRef` **故意不在这里**：写死一个默认引用名会让每条连接都指向同一个凭据、
 * 互相覆盖。引用名按连接名派生（见 {@link credentialRefFor}），密钥值走凭据服务。
 */
export function blankConnection() {
  return {
    name: '',
    protocol: 'system-one',
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    model: 'typesafe/jev-1.13',
    timeoutMs: 10000,
    /** 密码框里的密钥值：只在这次编辑里存在，写进凭据服务后立刻丢弃。 */
    key: '',
    /** 用户在编辑里点了「清除密钥」。 */
    clearKey: false,
  }
}

/**
 * 连接名 → 凭据引用名（`typesafe-main` → `TYPESAFE_MAIN_API_KEY`）。
 *
 * 这是撞车 bug 的修法：引用名必须**随连接唯一**，否则第二条连接会把第一条的密钥覆盖掉。
 * 与模型页 `<ROUTE>_API_KEY` 的派生同一套做法（那里也是"页面从不问环境变量名"）。
 */
export function credentialRefFor(connectionId) {
  const slug = String(connectionId ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (slug === '') return ''
  // 纯数字开头不是合法标识符，加一个前缀把它变成合法的引用名。
  return `${/^[A-Za-z]/.test(slug) ? slug : `JUDGMENT_${slug}`}_API_KEY`
}

export function connectionDraft(name, entry) {
  return {
    name,
    protocol: entry?.protocol ?? 'system-one',
    baseUrl: entry?.baseUrl ?? '',
    model: entry?.model ?? '',
    timeoutMs: entry?.timeoutMs ?? 10000,
    key: '',
    clearKey: false,
  }
}

export function blankPurpose() {
  return { name: '', connection: '' }
}

/**
 * 校验密码框里的密钥值。照模型页的判据：去掉首尾空白后非空，且每个字符都是可打印 ASCII
 * （`[\x21-\x7E]`）——HTTP 头里能带的就是这些。
 */
export function validateKey(value) {
  const key = String(value ?? '').trim()
  if (key === '') return '密钥不能为空（留空表示不修改已保存的密钥）'
  if (!/^[\x21-\x7E]+$/.test(key)) return '密钥只能包含可打印 ASCII 字符（不含空格与换行）'
  return null
}

/** 校验连接草稿；可以保存时返回 `null`，否则返回给人看的那句话。 */
export function validateConnection(draft) {
  const name = String(draft.name ?? '').trim()
  if (!NAME_PATTERN.test(name)) {
    return '连接名只能用字母、数字和 . - _，且不超过 64 个字符'
  }
  // 引用名从连接名派生，所以连接名必须能派生出合法的引用名（空也是不合法）。
  // 注意：CREDENTIAL_REF_PATTERN 允许空串（手写配置里"还没配密钥"是合法状态），
  // 所以这里用非空的那条判据。
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRefFor(name))) {
    return '连接名里至少要有一个字母或数字（凭据引用名由连接名派生）'
  }
  if (!BASE_URL_PATTERN.test(String(draft.baseUrl ?? '').trim())) {
    return '地址必须是 http(s) 且不含凭据、查询串或 # 片段（留空表示尚未配置）'
  }
  if (String(draft.model ?? '').trim() === '' || /\s/.test(String(draft.model))) {
    return '模型名不能为空、不能含空白字符（要 pin 到具体版本，别用 latest 别名）'
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

/** 写进配置的连接值（只保留 schema 认得的字段）。密钥值永远不进配置。 */
export function connectionValue(draft, connectionId, previousRef) {
  const existing = String(previousRef ?? '').trim()
  return {
    protocol: draft.protocol,
    baseUrl: String(draft.baseUrl ?? '').trim(),
    model: String(draft.model ?? '').trim(),
    // 已存在的引用名保持不变（改名不该把已存的密钥弄丢）；新建或原本为空时按连接名派生。
    credentialRef: existing !== '' ? existing : credentialRefFor(connectionId),
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
 * 连接的右侧状态。
 *
 * `keyState` 来自 `credentials.describe(ref)` 的读取结果：`undefined` = 还没读到，
 * `null` = 读不到（宿主没有凭据面），其余是 `{configured, writable, source}`。
 * 「已配置」只说密钥已在本地或环境里，**不等于远端已验证**。
 */
export function connectionStatus(entry, keyState) {
  if (String(entry?.baseUrl ?? '') === '') return { tone: 'warn', text: '未设地址' }
  if (String(entry?.model ?? '') === '') return { tone: 'warn', text: '未设模型' }
  if (String(entry?.credentialRef ?? '') === '') return { tone: 'warn', text: '未设凭据名' }
  if (keyState === undefined) return { tone: 'neutral', text: '配置完整 · 未自检' }
  if (keyState === null) return { tone: 'warn', text: '读不到密钥状态' }
  if (keyState.writable === false && keyState.configured === true) return { tone: 'ok', text: '密钥由环境提供' }
  if (keyState.configured === true) return { tone: 'ok', text: '密钥已配置 · 未自检' }
  return { tone: 'warn', text: '密钥未配置' }
}

/**
 * 密钥输入框的状态与文案。对齐模型页的做法：**不回显密钥**，而且「空」与「已配置」
 * 给的是两句不同的话（`placeholder` 与 `hint` 都不同）。
 */
export function keyFieldState(keyState) {
  if (keyState === undefined) {
    return { locked: false, placeholder: '填入 API key（保存后不回显）', hint: '正在读取密钥状态…' }
  }
  if (keyState === null) {
    return { locked: true, placeholder: '宿主未提供凭据面', hint: '这个 profile 里没有凭据服务，无法在这里写入密钥' }
  }
  if (keyState.writable === false) {
    return {
      locked: true,
      placeholder: '由启动环境提供（只读）',
      hint: `已由环境变量提供${keyState.source ? `（${keyState.source}）` : ''}，这里不能修改`,
    }
  }
  if (keyState.configured === true) {
    return {
      locked: false,
      placeholder: '已配置 · 留空表示不修改',
      hint: `已配置${keyState.source ? ` · 来源 ${keyState.source}` : ''}；留空即保持原值`,
    }
  }
  return { locked: false, placeholder: '填入 API key（保存后不回显）', hint: '尚未配置' }
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
