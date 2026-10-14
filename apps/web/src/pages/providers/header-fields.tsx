import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { emptyHeaderRow, type HeaderRow } from "@/lib/headers";

const MAX_ROWS = 20;

/**
 * Header name/value rows, the editor of both the provider's headers and one credential's overrides.
 * Blank rows are dropped and values trimmed on submit (`headerMap`), and the flexible tracks are
 * `minmax(0, 1fr)` so a long value can never widen the dialog.
 */
export function HeaderFields({
  rows,
  onChange,
  hint,
}: {
  rows: readonly HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  hint: string;
}) {
  const patch = (index: number, change: Partial<HeaderRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  return (
    <FieldSet>
      <FieldLegend variant="label">Custom headers</FieldLegend>
      <p className="text-muted-foreground">{hint}</p>
      {rows.length > 0 && (
        <div className="grid gap-2">
          {rows.map((row, i) => (
            <div
              key={i}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] items-center gap-2"
            >
              <Input
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-label={`Header ${i + 1} name`}
                placeholder="x-gateway"
                value={row.name}
                onChange={(e) => patch(i, { name: e.target.value })}
              />
              <Input
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-label={`Header ${i + 1} value`}
                placeholder="value"
                value={row.value}
                onChange={(e) => patch(i, { value: e.target.value })}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                aria-label={`Remove header ${i + 1}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rows.length >= MAX_ROWS}
          onClick={() => onChange([...rows, emptyHeaderRow()])}
        >
          <PlusIcon data-icon="inline-start" />
          Add header
        </Button>
      </div>
    </FieldSet>
  );
}
