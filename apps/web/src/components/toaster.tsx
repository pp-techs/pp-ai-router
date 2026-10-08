import { cx } from "../lib/cx.ts";
import { toast, useToasts } from "../lib/toast.ts";

export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 grid w-80 max-w-[calc(100vw-2rem)] gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={cx(
            "pointer-events-auto flex items-start gap-3 rounded-lg border px-3.5 py-2.5 shadow-lg",
            t.kind === "error"
              ? "border-danger/40 bg-danger-soft text-danger"
              : "border-ok/40 bg-ok-soft text-ok",
          )}
        >
          <p className="flex-1 break-words">{t.message}</p>
          <button
            type="button"
            aria-label="Dismiss"
            className="cursor-pointer opacity-70 hover:opacity-100"
            onClick={() => toast.dismiss(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
