import { useState } from "react";
import { METRICS, type LimitMode, type Metric } from "../../api/types.ts";
import { Field, Input, Select } from "../../components/fields.tsx";
import { METRIC_LABELS, WINDOW_PRESETS, type LimitDraft } from "../../lib/limits.ts";

const CUSTOM = "custom";

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
      <Field label="Metric">
        <Select
          value={draft.metric}
          onChange={(e) => onChange({ metric: e.target.value as Metric })}
        >
          {METRICS.map((m) => (
            <option key={m} value={m}>
              {METRIC_LABELS[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Window">
        <Select
          value={custom ? CUSTOM : draft.window}
          onChange={(e) => {
            const choice = e.target.value;
            setCustom(choice === CUSTOM);
            if (choice !== CUSTOM) onChange({ window: choice });
          }}
        >
          {WINDOW_PRESETS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
          <option value={CUSTOM}>custom…</option>
        </Select>
      </Field>
      <Field label="Mode">
        <Select
          value={draft.mode}
          onChange={(e) => onChange({ mode: e.target.value as LimitMode })}
        >
          <option value="fixed">fixed (UTC)</option>
          <option value="rolling">rolling</option>
        </Select>
      </Field>
      <Field label={draft.metric === "usd" ? "Max (USD)" : "Max"}>
        <Input
          inputMode="decimal"
          placeholder={draft.metric === "usd" ? "5.00" : "100000"}
          value={draft.max}
          onChange={(e) => onChange({ max: e.target.value })}
        />
      </Field>
      {custom && (
        <Field
          label="Custom window"
          hint="<n>m, h, d or w — e.g. 90m, 12h, 2w. Over a day: whole hours."
          className="col-span-2 sm:col-span-4"
        >
          <Input
            value={draft.window}
            placeholder="90m"
            onChange={(e) => onChange({ window: e.target.value })}
          />
        </Field>
      )}
    </div>
  );
}
