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
  describeConnection, dictOf, matchesQuery, purposeStatus, purposeTargetLabel, purposesUsing,
  snapshotOf, statusOf, validateConnection, validatePurpose, withoutKey,
} from './config.js'
import { Chevron, Field, MoreMenu, SearchIcon, Status, Tag } from './components.jsx'
import CSS from './styles.css'

const EMPTY = {}

export function Panel(props) {
  const form = props.form
  const [tick, setTick] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState(null)
  const [draft, setDraft] = useState(EMPTY)
  const [expanded, setExpanded] = useState('')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState(props.initialTab === 'purposes' ? 'purposes' : 'connections')

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
    const name = String(draft.name).trim()
    if (editor?.isNew === true && connections[name] !== undefined) {
      setError(`连接 "${name}" 已经存在`)
      return
    }
    if (await commit('connections', { ...connections, [name]: connectionValue(draft) })) closeEditor()
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

  async function removeConnection(id) {
    const affected = purposesUsing(purposes, id, defaultConnection)
    const note = affected.length === 0 ? '' : `\n\n有 ${affected.length} 处指向它（${affected.join('、')}），删除后那些用途会失效。`
    if (typeof window !== 'undefined' && !window.confirm(`删除连接「${id}」？${note}`)) return
    setError('')
    const clearingDefault = defaultConnection === id
    if (await commit('connections', withoutKey(connections, id))) {
      if (clearingDefault) await commit('defaultConnection', '')
      closeEditor()
    }
  }

  async function removePurpose(name) {
    if (typeof window !== 'undefined' && !window.confirm(`删除用途「${name}」？`)) return
    setError('')
    if (await commit('purposes', withoutKey(purposes, name))) closeEditor()
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

  function connectionCard(id) {
    const entry = connections[id] ?? {}
    const key = `connection:${id}`
    const open = expanded === key
    const state = connectionStatus(entry)
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
              <span className="jdg-detailsKey">凭据引用</span>
              <span className="jdg-detailsValue">{entry.credentialRef || '—'}</span>
              <span className="jdg-detailsKey">超时</span>
              <span className="jdg-detailsValue">{`${entry.timeoutMs ?? '—'} ms`}</span>
              <span className="jdg-detailsKey">被引用</span>
              <span className="jdg-detailsValue">{`${purposesUsing(purposes, id, '').length} 个用途`}</span>
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
          <Field label="凭据引用名" hint="密钥值不写进配置，只存这个名字">
            <input
              className="jdg-input"
              value={draft.credentialRef ?? ''}
              placeholder="TYPESAFE_API_KEY"
              onChange={(event) => setDraft({ ...draft, credentialRef: event.target.value })}
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
          密钥由 DSH 凭据服务保管：为上面这个引用名设值（或先导出同名环境变量），provider 每次调用现取，绝不缓存明文。
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
    </div>
  )
}
