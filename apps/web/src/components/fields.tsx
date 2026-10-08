import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cx } from "../lib/cx.ts";

const CONTROL =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted/70 disabled:opacity-60";

/** Label wraps its control, so no ids are needed to associate them. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("grid gap-1.5", className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(CONTROL, "min-h-20", className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(CONTROL, className)} {...rest} />;
}

export function Checkbox({
  label,
  className,
  ...rest
}: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className={cx("inline-flex items-center gap-2", className)}>
      <input type="checkbox" className="size-4 accent-accent" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export function FormError({ error }: { error: Error | null | string }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
      {typeof error === "string" ? error : error.message}
    </p>
  );
}
