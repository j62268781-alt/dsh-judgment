/**
 * 决策配置页：连接层 × 用途层，列表 + 增删改（无页签）。
 *
 * 视觉与交互对齐 skills-mcp 面板（用户要求）：一行「搜索 + 新增」，卡片**可展开**
 * （收起时只显示名字/标签/右侧状态，展开后是详情表），「…」里编辑删除，
 * 编辑时卡片就地变表单。写入走 `form.set(field, value)`，老宿主退回 `props.mutate`。
 */
import './react.js'
import { useEffect, useState } from 'react'
import {
  PROTOCOLS, blankConnection, blankPurpose, connectionDraft, connectionStatus, connectionValue,
  describeConnection, dictOf, keyFieldState, matchesQuery, purposeStatus,
  purposeTargetLabel, purposesUsing, resolveCredentialRef, shouldClearCredential, snapshotOf, statusOf,
  validateConnection, validateKey, validatePurpose, withoutKey,
} from './config.js'
import { Chevron, Field, MoreMenu, SearchIcon, Status, Tag } from './components.jsx'
import { ConfirmDialog } from './dialog.jsx'
import CSS from './styles.css'

const EMPTY = {}

export function Panel(props) {
  const form = props.form
  const [tick, setTick] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // 首次渲染就打开某个新增表单（测试用；也让将来做深链有落点）。
  const [editor, setEditor] = useState(props.initialEditor === 'connection' || props.initialEditor === 'purpose'
    ? { kind: props.initialEditor, isNew: true }
    : null)
  const [draft, setDraft] = useState(props.initialEditor === 'connection'
    ? blankConnection()
    : props.initialEditor === 'purpose' ? blankPurpose() : EMPTY)
  // 首次渲染就展开某张卡片（测试用；也让将来做深链有落点）。
  const [expanded, setExpanded] = useState(typeof props.initialExpanded === 'string' ? props.initialExpanded : '')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState(props.initialTab === 'purposes' ? 'purposes' : 'connections')
  /** 每个凭据引用名的状态（`describe` 的结果）：只读，永不回显密钥值。 */
  const [keyStates, setKeyStates] = useState({})
  /** 本页跑过的自检结果（按连接 id）。 */
  const [probes, setProbes] = useState({})
  /** 宿主 `status()` 里的「已验证」记忆（按连接 id）——刷新页面后卡片也说得对。 */
  const [verified, setVerified] = useState({})
  /** 删除确认弹窗（用 DSH 自带的 Modal；拿不到时退回原生 confirm）。 */
  const [confirm, setConfirm] = useState(null)
  const [confirmPending, setConfirmPending] = useState(false)
  const [confirmError, setConfirmError] = useState('')

  // 宿主的设置镜像变了就重画（别的编辑器/别的窗口写回也会走到这里）。
  useEffect(() => {
    if (typeof form?.subscribe !== 'function') return undefined
    return form.subscribe(() => setTick((count) => count + 1))
  }, [form])

  const value = snapshotOf(form)
  const status = statusOf(form)
  const connections = dictOf(value, 'connections')
  const purposes = dictOf(value, 'purposes')
  const defaultConnection = typeof value?.defaultConnection === 'string' ? value.defaultConnection : ''
  const writable = typeof form?.set === 'function' || typeof props.mutate === 'function'
  const credentials = props.credentials

  const keyRefs = [...new Set(Object.values(connections)
    .map((entry) => String(entry?.credentialRef ?? ''))
    .filter((ref) => ref !== ''))]
  const keyRefsKey = keyRefs.join('|')

  // 密钥状态一次读一批。describe 只回答「有没有配置 / 来源 / 可不可写」，**永远不返回值**。
  useEffect(() => {
    if (credentials === undefined || keyRefsKey === '') {
      setKeyStates({})
      return undefined
    }
    let alive = true
    void (async () => {
      try {
        const response = await credentials.describe(keyRefsKey.split('|'))
        if (!alive) return
        setKeyStates(response?.ok === true && response.value !== null && typeof response.value === 'object' ? response.value : {})
      } catch {
        if (alive) setKeyStates({})
      }
    })()
    return () => { alive = false }
  }, [credentials, keyRefsKey])

  const connectionIdsKey = Object.keys(connections).join('|')

  /**
   * 拉一次宿主 `status()`：把"已验证"的历史记忆取回来。
   *
   * 为什么需要：`verified` 存在 host 内存里（`health()` 成功过就记下），页面刷新后本地状态
   * 就没了；不拉这一下，卡片会在刷新后从「已验证」退回「未自检」——那是在对用户撒谎。
   */
  useEffect(() => {
    if (props.judgment === undefined) return undefined
    let alive = true
    void (async () => {
      try {
        const envelope = await props.judgment.status()
        if (!alive || envelope?.ok !== true) return
        const next = {}
        for (const entry of envelope.value?.connections ?? []) {
          if (entry?.verified === true) {
            next[entry.connection] = { ok: true, ...(typeof entry.verifiedAt === 'string' ? { at: entry.verifiedAt } : {}) }
          }
        }
        setVerified(next)
      } catch {
        // 读不到就保持「未自检」——不猜一个"已验证"出来。
      }
    })()
    return () => { alive = false }
  }, [props.judgment, connectionIdsKey])

  /** 写完密钥后刷新单个引用名的状态。 */
  async function refreshKeys(ref) {
    if (credentials === undefined || ref === '') return
    try {
      const response = await credentials.describe([ref])
      if (response?.ok === true && response.value !== null && typeof response.value === 'object') {
        setKeyStates((current) => ({ ...current, ...response.value }))
      }
    } catch {
      // 读不到状态就不显示状态，不把它当成"未配置"。
    }
  }

  /** 除"正在编辑的这一条"之外已被占用的引用名——分配空号时要避开它们。 */
  const excludeId = editor?.isNew === true ? undefined : editor?.id
  const otherRefs = Object.entries(connections)
    .filter(([id]) => id !== excludeId)
    .map(([, entry]) => String(entry?.credentialRef ?? ''))
  /** 正在编辑的这条连接最终用哪个引用名：已存在的不变，新建的分配一个空号。 */
  const draftPreviousRef = editor?.isNew === true ? '' : String(connections[editor?.id]?.credentialRef ?? '')
  const draftRef = resolveCredentialRef(draftPreviousRef, otherRefs)
  const draftKeyState = credentials === undefined
    ? null
    : keyRefs.includes(draftRef) ? keyStates[draftRef] : { configured: false }
  const draftKeyField = keyFieldState(draftKeyState)

  /** 正在编辑的那一条：过滤时也要留着，否则保存前表单会被搜掉。 */
  const editingConnection = editor?.kind === 'connection' && editor.isNew !== true ? editor.id : undefined
  const editingPurpose = editor?.kind === 'purpose' && editor.isNew !== true ? editor.id : undefined

  const connectionIds = Object.keys(connections)
    .filter((id) => id === editingConnection
      || matchesQuery([id, connections[id].protocol, connections[id].baseUrl, connections[id].model, connections[id].credentialRef], query))
  const purposeIds = Object.keys(purposes)
    .filter((name) => name === editingPurpose
      || matchesQuery([name, purposeTargetLabel(purposes[name], defaultConnection)], query))

  /** 一次写入：整个字段一次原子提交。 */
  async function commit(field, next) {
    setBusy(true)
    setError('')
    try {
      if (typeof form?.set === 'function') await form.set(field, next)
      else if (typeof props.mutate === 'function') await props.mutate(props.entryId, [{ op: 'set', path: [field], value: next }])
      else throw new Error('配置表单不可写：宿主既没有 set 也没有 mutate')
      setTick((count) => count + 1)
      return true
    } catch (cause) {
      setError(String(cause?.message ?? cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  function closeEditor() {
    setEditor(null)
    setDraft(EMPTY)
  }

  function openCreate(kind) {
    setError('')
    setEditor({ kind, isNew: true })
    setDraft(kind === 'connection' ? blankConnection() : blankPurpose())
  }

  function openEdit(kind, id) {
    setError('')
    setEditor({ kind, id, isNew: false })
    setDraft(kind === 'connection' ? connectionDraft(id, connections[id]) : { name: id, connection: purposes[id]?.connection ?? '' })
  }

  async function saveConnection() {
    const message = validateConnection(draft)
    if (message !== null) {
      setError(message)
      return
    }
    const key = String(draft.key ?? '').trim()
    // 密钥先校验再落配置：配置写成功而密钥被拒，留下的会是一条配了却用不了的状态。
    if (key !== '') {
      const invalid = validateKey(key)
      if (invalid !== null) {
        setError(invalid)
        return
      }
    }
    const name = String(draft.name).trim()
    if (editor?.isNew === true && connections[name] !== undefined) {
      setError(`连接 "${name}" 已经存在`)
      return
    }
    const previousRef = editor?.isNew === true ? '' : String(connections[name]?.credentialRef ?? '')
    const entry = connectionValue(draft, resolveCredentialRef(previousRef, otherRefs))
    // 配置先落盘、再写密钥——与模型页的两段式一致（配置没写成就别动凭据）。
    if (!(await commit('connections', { ...connections, [name]: entry }))) return
    if (credentials === undefined || key === '') {
      closeEditor()
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await credentials.set(entry.credentialRef, key)
      if (response?.ok !== true) {
        setError(`密钥未写入：${response?.error?.message ?? '未知原因'}`)
        return
      }
    } catch (cause) {
      setError(`密钥未写入：${String(cause?.message ?? cause)}`)
      return
    } finally {
      setBusy(false)
    }
    await refreshKeys(entry.credentialRef)
    closeEditor()
  }

  async function savePurpose() {
    const message = validatePurpose(draft)
    if (message !== null) {
      setError(message)
      return
    }
    const name = String(draft.name).trim()
    if (editor?.isNew === true && purposes[name] !== undefined) {
      setError(`用途 "${name}" 已经存在`)
      return
    }
    if (await commit('purposes', { ...purposes, [name]: { connection: String(draft.connection ?? '') } })) closeEditor()
  }

  /**
   * 打开删除确认：优先用 DSH 自带的 Modal（与内置页面、skills-mcp 面板同一个弹窗），
   * 拿不到 primitives 时退回原生 confirm —— 没有官方组件也不该让删除不可用。
   */
  function askRemove(kind, label, note, run) {
    if (props.primitives?.Modal === undefined) {
      const verb = kind === 'connection' ? '连接' : '用途'
      if (typeof window !== 'undefined' && !window.confirm(`删除${verb}「${label}」？\n\n${note}`)) return
      void run().catch((cause) => setError(String(cause?.message ?? cause)))
      return
    }
    setConfirmError('')
    setConfirm({ kind, label, note, run })
  }

  async function confirmRemove() {
    if (confirm === null) return
    setConfirmPending(true)
    setConfirmError('')
    try {
      await confirm.run()
      setConfirm(null)
    } catch (cause) {
      // 失败就让弹窗留着并说明原因，别把它关掉让人以为删成功了。
      setConfirmError(String(cause?.message ?? cause))
    } finally {
      setConfirmPending(false)
    }
  }

  /**
   * 删除连接：**先清密钥、再删配置**。序号会被回收，孤儿凭据会让下一条连接读到上一把
   * 遗留的 key，所以密钥没清掉就中止删除（比"删除失败要重试"危险得多）。
   * 例外：密钥由环境变量提供（只读）时没有我们存的东西可清，跳过它、不要挡住删除。
   */
  async function deleteConnection(id, ref) {
    if (credentials !== undefined && shouldClearCredential(ref, keyStates[ref])) {
      const response = await credentials.unset(ref)
      if (response?.ok !== true) throw new Error(`密钥未清除，已取消删除：${response?.error?.message ?? '未知原因'}`)
    }
    const clearingDefault = defaultConnection === id
    if (!(await commit('connections', withoutKey(connections, id)))) throw new Error('配置未写入')
    if (clearingDefault) await commit('defaultConnection', '')
    closeEditor()
  }

  async function deletePurpose(name) {
    if (!(await commit('purposes', withoutKey(purposes, name)))) throw new Error('配置未写入')
    closeEditor()
  }

  function removeConnection(id) {
    const affected = purposesUsing(purposes, id, defaultConnection)
    const ref = String(connections[id]?.credentialRef ?? '')
    const note = [
      affected.length === 0 ? '' : `有 ${affected.length} 处指向它（${affected.join('、')}），删除后那些用途会失效。`,
      ref === ''
        ? '这个连接还没有密钥。'
        : `它的密钥（${ref}）会一并清除——序号会被回收，留着会让下一条连接读到这把遗留的 key。`,
    ].join(' ')
    askRemove('connection', id, note, () => deleteConnection(id, ref))
  }

  function removePurpose(name) {
    askRemove('purpose', name, '删除后，消费者再报这个用途名会直接报错（不会静默换连接）。', () => deletePurpose(name))
  }

  function toggle(key) {
    setExpanded((current) => (current === key ? '' : key))
  }

  /** 换页签时的重置照面板的做法：收起展开行、关掉就地编辑器、清搜索与错误。 */
  function selectTab(next) {
    if (next === tab) return
    setTab(next)
    setExpanded('')
    setEditor(null)
    setDraft(EMPTY)
    setQuery('')
    setError('')
  }

  /* ─────────────────── 连接 ─────────────────── */

  /** 自检结论：本页刚跑的结果优先，其次用宿主 `status()` 里的历史记忆。 */
  function verificationOf(id) {
    const probed = probes[id]
    if (probed === undefined) return verified[id]
    if (probed.busy === true) return undefined
    return probed
  }

  /**
   * 跑一次自检：让 **host 半**发一次最小请求（`ctx.judgment.health()`）。
   *
   * 两条实测约束：Remote 返回的是**信封**（`{ok,value}` / `{ok,error}`，resolve 不 reject）；
   * 实参个数必须与 host 形参个数相等（`health` 有一个可选参，所以这里显式给一个对象）。
   * `signal` 不能过线（AbortSignal 不是 JSON），所以只传 connection。
   */
  async function runProbe(id) {
    if (props.judgment === undefined) return
    setProbes((current) => ({ ...current, [id]: { busy: true } }))
    try {
      const envelope = await props.judgment.health({ connection: id })
      if (envelope?.ok === true) {
        const value = envelope.value ?? {}
        setProbes((current) => ({
          ...current,
          [id]: {
            ok: true,
            ...(typeof value.latencyMs === 'number' ? { latencyMs: value.latencyMs } : {}),
            ...(typeof value.model === 'string' ? { model: value.model } : {}),
            ...(typeof value.checkedAt === 'string' ? { at: value.checkedAt } : {}),
          },
        }))
        return
      }
      const failure = envelope?.error
      const detail = failure === undefined
        ? '宿主返回了失败但没有原因'
        : `${failure.code ?? 'error'} · ${failure.message ?? ''}`.trim()
      setProbes((current) => ({ ...current, [id]: { ok: false, message: detail } }))
    } catch (cause) {
      setProbes((current) => ({ ...current, [id]: { ok: false, message: String(cause?.message ?? cause) } }))
    }
  }

  function connectionCard(id) {
    const entry = connections[id] ?? {}
    const key = `connection:${id}`
    const open = expanded === key
    const ref = String(entry.credentialRef ?? '')
    const probe = probes[id]
    const state = connectionStatus(entry, ref === '' ? null : keyStates[ref], verificationOf(id))
    return (
      <li className="jdg-card" key={key}>
        <div className="jdg-cardRow">
          <button
            type="button"
            className="jdg-cardToggle"
            aria-expanded={open}
            onClick={() => toggle(key)}
          >
            <Chevron open={open} />
            <span className="jdg-cardIdentity">
              {id}
              <Tag>{entry.protocol}</Tag>
            </span>
          </button>
          <span className="jdg-cardEnd"><Status tone={state.tone} text={state.text} /></span>
          <span className="jdg-cardActions">
            <MoreMenu
              disabled={busy || !writable}
              items={[
                ['编辑', () => openEdit('connection', id)],
                ['删除', () => { void removeConnection(id) }, 'danger'],
              ]}
            />
          </span>
        </div>
        <div className="jdg-cardDescription">{describeConnection(entry)}</div>
        {open ? (
          <div className="jdg-cardDetails">
            <div className="jdg-details">
              <span className="jdg-detailsKey">地址</span>
              <span className="jdg-detailsValue">{entry.baseUrl || '—'}</span>
              <span className="jdg-detailsKey">模型</span>
              <span className="jdg-detailsValue">{entry.model || '—'}</span>
              <span className="jdg-detailsKey">凭据名</span>
              <span className="jdg-detailsValue">{ref || '—（按连接名派生）'}</span>
              <span className="jdg-detailsKey">密钥</span>
              <span className="jdg-detailsValue">{state.text}</span>
              <span className="jdg-detailsKey">超时</span>
              <span className="jdg-detailsValue">{`${entry.timeoutMs ?? '—'} ms`}</span>
              <span className="jdg-detailsKey">被引用</span>
              <span className="jdg-detailsValue">{`${purposesUsing(purposes, id, '').length} 个用途`}</span>
            </div>
            <div className="jdg-inlineRow">
              <button
                type="button"
                className="jdg-button"
                data-variant="outline"
                disabled={probe?.busy === true || props.judgment === undefined}
                onClick={() => { void runProbe(id) }}
              >
                {probe?.busy === true ? '自检中…' : '自检'}
              </button>
              <span className="jdg-note">
                {props.judgment === undefined
                  ? '宿主未提供自检通路：只能看到本地「已配置」，无法确认远端可用'
                  : probe?.busy === true
                    ? '正在向这个端点发一次最小请求…'
                    : probe?.ok === true
                      ? `自检通过 · ${probe.latencyMs ?? '—'}ms · 模型快照 ${probe.model ?? '—'}`
                      : probe?.ok === false
                        ? `自检失败 · ${probe.message}${/404|transport failure/.test(probe.message) ? '（host 半可能还是旧版本：插件更新后需要重启 DSH 才会重新加载）' : ''}`
                        : '自检会真发一次请求（约 30–100 输入 token），确认地址、凭据与模型名真的可用'}
              </span>
            </div>
          </div>
        ) : null}
      </li>
    )
  }

  function connectionForm() {
    return (
      <li className="jdg-card" key="connection:form">
        <div className="jdg-formGrid">
          <Field label="连接名" hint="消费者看不到它；用途指向它">
            <input
              className="jdg-input"
              value={draft.name ?? ''}
              readOnly={editor?.isNew !== true}
              placeholder="typesafe-main"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label="协议">
            <select
              className="jdg-select"
              value={draft.protocol ?? 'system-one'}
              onChange={(event) => setDraft({ ...draft, protocol: event.target.value })}
            >
              {PROTOCOLS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </Field>
          <Field label="地址（baseUrl）" wide hint="不含凭据、查询串或 # 片段">
            <input
              className="jdg-input"
              value={draft.baseUrl ?? ''}
              placeholder="https://api.typesafe.ai/v1/systemone"
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </Field>
          <Field label="模型" hint="pin 到具体版本，别用 jev-latest 这类移动别名">
            <input
              className="jdg-input"
              value={draft.model ?? ''}
              placeholder="typesafe/jev-1.13"
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
          </Field>
          <Field label="密钥" wide hint={`${draftKeyField.hint} · 凭据名 ${draftRef}（也可以直接把它当环境变量名用，环境变量优先）`}>
            <input
              className="jdg-input"
              type="password"
              autoComplete="new-password"
              value={draft.key ?? ''}
              placeholder={draftKeyField.placeholder}
              disabled={busy || draftKeyField.locked}
              onChange={(event) => setDraft({ ...draft, key: event.target.value })}
            />
          </Field>
          <Field label="超时（ms）">
            <input
              className="jdg-input"
              type="number"
              min="1"
              max="300000"
              step="1"
              value={draft.timeoutMs ?? ''}
              onChange={(event) => setDraft({ ...draft, timeoutMs: event.target.value })}
            />
          </Field>
        </div>
        <p className="jdg-note">
          {`密钥写进 DSH 凭据服务（引用名 ${draftRef}，自动分配），不写进配置、保存后不回显。`}
          {` 留空即保持原值；要移除密钥请删除这条连接（删除会一并清除它）。`}
          {` 也可以不在这里填：在启动环境里设 ${draftRef}=… （或写进 ~/.dsh/.env）即可，启动环境优先级最高，那时这里会显示为只读。`}
        </p>
        <div className="jdg-actionsRow">
          <button className="jdg-button" data-variant="primary" disabled={busy} onClick={() => { void saveConnection() }}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button className="jdg-button" data-variant="outline" disabled={busy} onClick={closeEditor}>取消</button>
        </div>
      </li>
    )
  }

  /* ─────────────────── 用途 ─────────────────── */

  function purposeCard(name) {
    const purpose = purposes[name] ?? {}
    const key = `purpose:${name}`
    const open = expanded === key
    const state = purposeStatus(purpose, connections, defaultConnection)
    const target = purposeTargetLabel(purpose, defaultConnection)
    return (
      <li className="jdg-card" key={key}>
        <div className="jdg-cardRow">
          <button
            type="button"
            className="jdg-cardToggle"
            aria-expanded={open}
            onClick={() => toggle(key)}
          >
            <Chevron open={open} />
            <span className="jdg-cardIdentity">
              {name}
              <Tag tone={state.tone === 'ok' ? 'ok' : 'neutral'}>{target}</Tag>
            </span>
          </button>
          <span className="jdg-cardEnd"><Status tone={state.tone} text={state.text} /></span>
          <span className="jdg-cardActions">
            <MoreMenu
              disabled={busy || !writable}
              items={[
                ['编辑', () => openEdit('purpose', name)],
                ['删除', () => { void removePurpose(name) }, 'danger'],
              ]}
            />
          </span>
        </div>
        <div className="jdg-cardDescription">
          {String(purpose.connection ?? '') === ''
            ? '未指定连接：调用时落到「默认连接」'
            : `消费者报用途名 "${name}" 时，走连接 "${purpose.connection}"`}
        </div>
        {open ? (
          <div className="jdg-cardDetails">
            <div className="jdg-details">
              <span className="jdg-detailsKey">指向连接</span>
              <span className="jdg-detailsValue">{String(purpose.connection ?? '') || '（跟随默认连接）'}</span>
              <span className="jdg-detailsKey">实际使用</span>
              <span className="jdg-detailsValue">{state.tone === 'danger' ? '无法解析' : target}</span>
              <span className="jdg-detailsKey">调用方式</span>
              <span className="jdg-detailsValue">{`ctx.judgment.ask(state, questions, { purpose: '${name}' })`}</span>
            </div>
          </div>
        ) : null}
      </li>
    )
  }

  function purposeForm() {
    return (
      <li className="jdg-card" key="purpose:form">
        <div className="jdg-formGrid">
          <Field label="用途名" hint="消费者用它来要能力，例如 mobile.action / browser.action">
            <input
              className="jdg-input"
              value={draft.name ?? ''}
              readOnly={editor?.isNew !== true}
              placeholder="mobile.action"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label="指向连接">
            <select
              className="jdg-select"
              value={draft.connection ?? ''}
              onChange={(event) => setDraft({ ...draft, connection: event.target.value })}
            >
              <option value="">跟随默认连接</option>
              {Object.keys(connections).map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </Field>
        </div>
        <div className="jdg-actionsRow">
          <button className="jdg-button" data-variant="primary" disabled={busy} onClick={() => { void savePurpose() }}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button className="jdg-button" data-variant="outline" disabled={busy} onClick={closeEditor}>取消</button>
        </div>
      </li>
    )
  }

  /* ─────────────────── 渲染 ─────────────────── */

  const connectionCards = [
    ...(editor?.kind === 'connection' && editor.isNew === true ? [connectionForm()] : []),
    ...connectionIds.map((id) => (editingConnection === id ? connectionForm() : connectionCard(id))),
  ]

  const purposeCards = [
    ...(editor?.kind === 'purpose' && editor.isNew === true ? [purposeForm()] : []),
    ...purposeIds.map((name) => (editingPurpose === name ? purposeForm() : purposeCard(name))),
  ]

  const connectionCount = Object.keys(connections).length
  const purposeCount = Object.keys(purposes).length

  /** 两个页签的文案与列表，形状对齐 skills-mcp 面板（页签标签带计数）。 */
  const lists = {
    connections: {
      tab: `连接（${connectionCount}）`,
      summary: `共 ${connectionCount} 条 · 每条 = （协议 · 地址 · 模型 · 凭据引用）；密钥值不在配置里，只存引用名`,
      placeholder: '搜索连接名 / 地址 / 模型',
      addLabel: '新增连接',
      empty: '还没有连接。一条连接就是一组「协议 + 地址 + 模型 + 凭据引用」。',
      cards: connectionCards,
    },
    purposes: {
      tab: `用途（${purposeCount}）`,
      summary: `共 ${purposeCount} 个 · 给消费者一个稳定名字：代码里只写用途名，换连接 / 换模型 / 换密钥都不用改代码`,
      placeholder: '搜索用途名 / 指向连接',
      addLabel: '新增用途',
      empty: '还没有用途。消费者用用途名要能力（例如 mobile.action），在这里把它指向一条连接。',
      cards: purposeCards,
    },
  }
  const active = lists[tab] ?? lists.connections

  void tick

  return (
    <div className="jdg-page">
      <style>{CSS}</style>
      <header className="jdg-pageHead">
        <div>
          <h2 className="jdg-pageTitle">决策</h2>
          <p className="jdg-pageIntro">
            结构化判断能力：一次调用 = 一份状态 + 一批命名问题 → 概率答案。它判断，消费者决定。
          </p>
        </div>
      </header>

      <div className="jdg-tabs">
        {Object.entries(lists).map(([id, list]) => (
          <button type="button" key={id} className="jdg-tab" data-active={tab === id} onClick={() => selectTab(id)}>
            {list.tab}
          </button>
        ))}
      </div>

      <div className="jdg-summary">{active.summary}</div>

      <div className="jdg-filterRow">
        <span className="jdg-search">
          <span className="jdg-searchIcon"><SearchIcon /></span>
          <input
            className="jdg-searchInput"
            value={query}
            placeholder={active.placeholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
        <button
          className="jdg-button"
          data-variant="primary"
          disabled={busy || !writable}
          onClick={() => openCreate(tab === 'connections' ? 'connection' : 'purpose')}
        >
          {active.addLabel}
        </button>
      </div>

      {status === 'loading' ? <p className="jdg-empty">正在读取设置…</p> : null}
      {writable ? null : <p className="jdg-note">当前设置文档不可写：这个 profile 里该插件的配置被更高层覆盖了。</p>}
      {error !== '' ? <p className="jdg-error">{error}</p> : null}

      {/* 「默认连接」放在用途页：用途卡片上的「跟随默认连接」说的就是它。 */}
      {tab === 'purposes' ? (
        <div className="jdg-inlineRow">
          <span className="jdg-label">未指定连接的用途落到</span>
          <select
            className="jdg-select"
            value={defaultConnection}
            disabled={busy || !writable}
            onChange={(event) => { void commit('defaultConnection', event.target.value) }}
          >
            <option value="">未设置 —— 只配了一条连接时用那一条，否则调用必须给用途名</option>
            {Object.keys(connections).map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
      ) : null}

      <ul className="jdg-cards">
        {active.cards.length === 0
          ? <li className="jdg-empty">{query === '' ? active.empty : '没有匹配的条目。'}</li>
          : active.cards}
      </ul>

      {/* 删除确认用 DSH 自带的 Modal（与内置页面同一个弹窗）；拿不到时走原生 confirm。 */}
      <ConfirmDialog
        dialog={confirm}
        primitives={props.primitives}
        pending={confirmPending}
        error={confirmError}
        onCancel={() => { setConfirm(null); setConfirmError('') }}
        onConfirm={() => { void confirmRemove() }}
      />
    </div>
  )
}
