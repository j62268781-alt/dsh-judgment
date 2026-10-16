/** 页面用到的小组件。写法与 skills-mcp 面板一致：卡片 + 表单网格 + 「…」菜单。 */
import './react.js'
import { useState } from 'react'

/** 表单字段：标签在上、控件在下，可跨两列。 */
export function Field({ label, hint, wide, children }) {
  return (
    <div className="jdg-field" data-wide={wide === true ? 'true' : undefined}>
      <span className="jdg-label">{label}</span>
      {children}
      {hint ? <span className="jdg-hint">{hint}</span> : null}
    </div>
  )
}

/**
 * 「…」菜单：把编辑/删除收进一个 popup（照 MCP 卡片的做法）。
 * 打开时挂一层遮罩，免得一次无关点击把菜单留在原地、下一次点击误触菜单项。
 */
export function MoreMenu({ items, disabled }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="jdg-more">
      <button
        type="button"
        className="jdg-moreTrigger"
        disabled={disabled === true}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多操作"
        onClick={() => setOpen((current) => !current)}
      >
        ⋯
      </button>
      {open ? (
        <>
          <span className="jdg-menuScrim" onClick={() => setOpen(false)} />
          <span className="jdg-menu" role="menu">
            {items.map(([label, run, variant, itemDisabled]) => (
              <button
                type="button"
                key={label}
                role="menuitem"
                className="jdg-menuItem"
                data-variant={variant}
                disabled={itemDisabled === true}
                onClick={() => { setOpen(false); if (itemDisabled === true) return; run() }}
              >
                {label}
              </button>
            ))}
          </span>
        </>
      ) : null}
    </span>
  )
}

/** 卡片右上角的状态标签。 */
export function Tag({ children, tone = 'neutral' }) {
  return <span className="jdg-tag" data-tone={tone}>{children}</span>
}

/** 卡片左侧的展开箭头（收起时转 -90°）。 */
export function Chevron({ open }) {
  return (
    <svg
      className="jdg-chevron"
      data-open={String(open)}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 搜索结果行右侧的圆点状态（颜色承担状态，文字承担含义）。 */
export function Status({ tone, text }) {
  return (
    <span className="jdg-status">
      <span className="jdg-dot" data-dot={tone} aria-hidden="true" />
      <span className="jdg-statusText">{text}</span>
    </span>
  )
}

/** 搜索框里的放大镜。 */
export function SearchIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2 13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
