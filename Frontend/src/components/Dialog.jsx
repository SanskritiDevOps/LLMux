import { useEffect, useId, useRef } from "react";

const PLACEMENT = {
  center: "m-auto w-[calc(100%-2rem)] max-w-md rounded-lg",
  side: "my-0 mr-0 ml-auto h-full max-h-none w-full max-w-lg",
};

/**
 * A modal built on the native <dialog>: the browser keeps focus inside it, Escape closes
 * it, and the page behind can't be used. Clicking the backdrop closes it too, unless
 * `closeOnBackdrop` is false (when closing would lose something, like a key shown once).
 *
 * @param {{ open: boolean, onClose: () => void, title: string,
 *   variant?: "center" | "side", closeOnBackdrop?: boolean, footer?: React.ReactNode,
 *   children: React.ReactNode }} props
 */
export function Dialog({
  open,
  onClose,
  title,
  variant = "center",
  closeOnBackdrop = true,
  footer,
  children,
}) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === ref.current) onClose();
      }}
      className={`border border-slate-800 bg-slate-900 p-0 text-slate-100 backdrop:bg-slate-950/70 ${PLACEMENT[variant]}`}
    >
      {open && (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-slate-800 p-4">
            <h2 id={titleId} className="text-lg font-medium">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md px-2 text-slate-400 transition-colors duration-150 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-slate-800 p-4">{footer}</div>
          )}
        </div>
      )}
    </dialog>
  );
}
