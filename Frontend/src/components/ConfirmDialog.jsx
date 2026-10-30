import { Button } from "./Button.jsx";
import { Dialog } from "./Dialog.jsx";
import { ErrorNotice } from "./ErrorNotice.jsx";

/** Asks before a destructive action. The confirm button says exactly what will happen. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  pending = false,
  error,
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-300">
        {children}
        {error && <ErrorNotice error={error} />}
      </div>
    </Dialog>
  );
}
