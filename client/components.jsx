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
            {items.map(([label, run, variant]) => (
              <button
                type="button"
                key={label}
                role="menuitem"
                className="jdg-menuItem"
                data-variant={variant}
                onClick={() => { setOpen(false); run() }}
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
