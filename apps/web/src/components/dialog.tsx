import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { Button } from "./button.tsx";

/**
 * Modal built on the native <dialog>: focus trap, Escape and inert background come from the browser.
 * Mounting opens it, so parents render `{open && <Dialog …/>}` and every open starts from fresh state.
 */
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
  persistent = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Only the buttons close it: no Escape, no backdrop click (for one-time secrets). */
  persistent?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog
      .querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]), select, textarea")
      ?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => persistent && event.preventDefault()}
      onClick={(event) => !persistent && event.target === event.currentTarget && onClose()}
      className={cx(
        "m-auto w-[calc(100%-2rem)] rounded-xl border border-line bg-surface p-0 text-fg shadow-2xl",
        wide ? "max-w-2xl" : "max-w-lg",
      )}
    >
      <div className="grid max-h-[90vh] gap-4 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <Button variant="ghost" small aria-label="Close dialog" onClick={onClose}>
            ✕
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 pt-1">{children}</div>;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  loading,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="text-muted">{message}</div>
      <DialogActions>
        <Button data-autofocus onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
