/**
 * 删除确认：用 **DSH 自带的 UI primitives**（Modal / Button），所以和内置页面、
 * 以及 skills-mcp 面板的删除弹窗是同一个观感，而不是原生 confirm。
 *
 * `primitives` 由 apply 时从宿主模块表取（见 client/index.jsx）；取不到时这里返回 null，
 * 由调用方退回原生 confirm —— 拿不到官方组件不该让页面不能用。
 */
import './react.js'

export function ConfirmDialog({ dialog, primitives, onCancel, onConfirm, pending = false, error = '' }) {
  if (dialog === null || dialog === undefined) return null
  const Modal = primitives?.Modal
  if (Modal === undefined) return null
  const Button = primitives.Button ?? 'button'

  return (
    <Modal
      open
      onClose={onCancel}
      title={`删除${dialog.kind === 'connection' ? '连接' : '用途'}「${dialog.label}」？`}
      closeLabel="关闭"
      description={
        <div className="jdg-deleteMeta">
          <div>{dialog.note}</div>
          {error !== '' ? <div className="jdg-error" style={{ marginTop: 6 }}>{error}</div> : null}
          {pending ? <div className="jdg-pendingHint">正在删除并刷新配置…</div> : null}
        </div>
      }
      footer={
        <>
          <Button variant="outline" key="cancel" onClick={onCancel} disabled={pending}>取消</Button>
          <Button variant="primary" key="ok" onClick={onConfirm} disabled={pending}>
            {pending ? '删除中…' : '删除'}
          </Button>
        </>
      }
    />
  )
}
