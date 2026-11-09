import { FilterXIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Provider, UsageQuery, UsageStatus, VirtualKey } from "@/api/types";
import { FormField } from "@/components/form-field";
import { OptionSelect } from "@/components/option-select";
import { Panel } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "ok", label: "Successful" },
  { value: "error", label: "Errors" },
  { value: "aborted", label: "Aborted" },
  { value: "no_usage", label: "No usage" },
] as const;

const TRAFFIC_OPTIONS = [
  { value: "", label: "Any traffic" },
  { value: "1", label: "Streamed" },
  { value: "0", label: "Buffered" },
] as const;

const PRICE_OPTIONS = [
  { value: "", label: "Any price" },
  { value: "1", label: "Unpriced only" },
] as const;

/** Drop empty fields so the query string (and the query key) only carries active filters. */
function clean(query: UsageQuery): UsageQuery {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== ""),
  ) as UsageQuery;
}

/**
 * One filter set for the whole dashboard: the activity chart, the summary and the ledger read the
 * same query, so picking a provider or a status narrows every panel at once.
 */
export function UsageFilterBar({
  keys,
  providers,
  value,
  onChange,
}: {
  keys: VirtualKey[] | undefined;
  providers: Provider[] | undefined;
  value: UsageQuery;
  onChange: (next: UsageQuery) => void;
}) {
  const [model, setModel] = useState(value.q ?? "");
  // Clear (or a deep link) replaces the query; keep the search box in step.
  useEffect(() => setModel(value.q ?? ""), [value.q]);

  const applyModel = () => onChange(clean({ ...value, q: model.trim() }));
  const active = Object.keys(value).length > 0;

  return (
    <Panel
      title="Filters"
      description="Narrow the activity chart, summary and ledger together."
      actions={
        active && (
          <Button variant="outline" size="sm" onClick={() => onChange({})}>
            <FilterXIcon aria-hidden />
            Clear filters
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="API key" className="w-auto min-w-40">
          <OptionSelect
            aria-label="API key"
            value={value.key_id ?? ""}
            onValueChange={(v) => onChange(clean({ ...value, key_id: v || undefined }))}
            options={[
              { value: "", label: "All keys" },
              ...(keys?.map((k) => ({ value: k.id, label: k.name })) ?? []),
            ]}
          />
        </FormField>
        <FormField label="Provider" className="w-auto min-w-40">
          <OptionSelect
            aria-label="Provider"
            value={value.provider_id ?? ""}
            onValueChange={(v) => onChange(clean({ ...value, provider_id: v || undefined }))}
            options={[
              { value: "", label: "All providers" },
              ...(providers?.map((p) => ({ value: p.id, label: p.id })) ?? []),
            ]}
          />
        </FormField>
        <FormField label="Status" className="w-auto min-w-36">
          <OptionSelect
            aria-label="Status"
            value={value.status ?? ""}
            onValueChange={(v) =>
              onChange(clean({ ...value, status: (v || undefined) as UsageStatus | undefined }))
            }
            options={STATUS_OPTIONS}
          />
        </FormField>
        <FormField label="Traffic" className="w-auto min-w-36">
          <OptionSelect
            aria-label="Traffic"
            value={value.stream === undefined ? "" : String(value.stream)}
            onValueChange={(v) =>
              onChange(clean({ ...value, stream: v === "" ? undefined : (Number(v) as 0 | 1) }))
            }
            options={TRAFFIC_OPTIONS}
          />
        </FormField>
        <FormField label="Pricing" className="w-auto min-w-36">
          <OptionSelect
            aria-label="Pricing"
            value={value.unpriced === undefined ? "" : "1"}
            onValueChange={(v) => onChange(clean({ ...value, unpriced: v === "" ? undefined : 1 }))}
            options={PRICE_OPTIONS}
          />
        </FormField>
        <FormField label="Model" className="w-auto min-w-56" hint="Requested or upstream name.">
          <div className="flex gap-2">
            <Input
              aria-label="Model search"
              placeholder="Search models…"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                applyModel();
              }}
            />
            <Button type="button" variant="outline" size="icon-sm" onClick={applyModel}>
              <SearchIcon aria-hidden />
              <span className="sr-only">Apply model search</span>
            </Button>
          </div>
        </FormField>
      </div>
    </Panel>
  );
}
