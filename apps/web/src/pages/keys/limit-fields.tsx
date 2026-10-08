import { useState } from "react";
import { METRICS, type LimitMode, type Metric } from "@/api/types";
import { FormField } from "@/components/form-field";
import { OptionSelect } from "@/components/option-select";
import { Input } from "@/components/ui/input";
import { METRIC_LABELS, WINDOW_PRESETS, type LimitDraft } from "@/lib/limits";

const CUSTOM = "custom";

const METRIC_OPTIONS = METRICS.map((m) => ({ value: m, label: METRIC_LABELS[m] }));
const WINDOW_LABELS: Record<string, string> = {
  "30m": "30 minutes",
  "1h": "1 hour",
  "1d": "1 day",
  "7d": "7 days",
  total: "Total",
};
const WINDOW_OPTIONS = [
  ...WINDOW_PRESETS.map((w) => ({ value: w, label: WINDOW_LABELS[w] ?? w })),
  { value: CUSTOM, label: "Custom…" },
];
const MODE_OPTIONS = [
  { value: "fixed", label: "Fixed (UTC)" },
  { value: "rolling", label: "Rolling" },
];

/** One limit: metric x window x mode x max. The window is a preset or free text such as "90m" or "2w". */
export function LimitFields({
  draft,
  onChange,
}: {
  draft: LimitDraft;
  onChange: (patch: Partial<LimitDraft>) => void;
}) {
  const [custom, setCustom] = useState(!WINDOW_PRESETS.includes(draft.window));

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <FormField label="Metric">
        <OptionSelect
          value={draft.metric}
          options={METRIC_OPTIONS}
          onValueChange={(v) => onChange({ metric: v as Metric })}
        />
      </FormField>
      <FormField label="Window">
        <OptionSelect
          value={custom ? CUSTOM : draft.window}
          options={WINDOW_OPTIONS}
          onValueChange={(choice) => {
            setCustom(choice === CUSTOM);
            if (choice !== CUSTOM) onChange({ window: choice });
          }}
        />
      </FormField>
      <FormField label="Mode">
        <OptionSelect
          value={draft.mode}
          options={MODE_OPTIONS}
          onValueChange={(v) => onChange({ mode: v as LimitMode })}
        />
      </FormField>
      <FormField label={draft.metric === "usd" ? "Max (USD)" : "Max"}>
        <Input
          inputMode="decimal"
          placeholder={draft.metric === "usd" ? "5.00" : "100000"}
          value={draft.max}
          onChange={(e) => onChange({ max: e.target.value })}
        />
      </FormField>
      {custom && (
        <FormField
          label="Custom window"
          hint="<n>m, h, d or w — e.g. 90m, 12h, 2w. Over a day: whole hours."
          className="col-span-2 sm:col-span-4"
        >
          <Input
            value={draft.window}
            placeholder="90m"
            onChange={(e) => onChange({ window: e.target.value })}
          />
        </FormField>
      )}
    </div>
  );
}
