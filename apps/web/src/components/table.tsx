import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cx } from "../lib/cx.ts";

/** `wide` tables keep their natural width and scroll sideways on narrow screens instead of squeezing cells. */
export function Table({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full border-collapse text-left", wide && "min-w-176")}>
        {children}
      </table>
    </div>
  );
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cx(
        "border-b border-line px-2.5 py-2 text-xs font-medium whitespace-nowrap text-muted",
        className,
      )}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cx("border-b border-line/60 px-2.5 py-2.5 align-middle", className)} {...rest} />
  );
}

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cx("last:[&>td]:border-b-0", className)} {...rest} />;
}
