import type { ButtonHTMLAttributes } from "react";
import { cx } from "../lib/cx.ts";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-line bg-surface text-fg hover:bg-subtle",
  danger: "border border-danger/40 bg-surface text-danger hover:bg-danger-soft",
  ghost: "text-muted hover:bg-subtle hover:text-fg",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  small?: boolean;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  small = false,
  loading = false,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        small ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
