import { Checkbox, Field, Input, Select } from "../../components/fields.tsx";
import { STRATEGIES, type Strategy } from "../../api/types.ts";

export interface ProviderSettingsDraft {
  base_url: string;
  key_strategy: Strategy;
  sticky_ttl_sec: string;
  max_key_attempts: string;
  enabled: boolean;
}

const STRATEGY_HINTS: Record<Strategy, string> = {
  round_robin: "Rotate through the credentials in turn.",
  weighted: "Interleave picks in proportion to each credential's weight.",
  least_inflight: "The credential with the fewest requests in flight.",
  least_used: "The credential with the fewest recent tokens per unit of weight.",
  fill_first: "The lowest priority number first; others only when it is unavailable.",
  random: "A uniformly random credential.",
};

export function ProviderSettingsFields({
  draft,
  onChange,
  baseUrlRequired,
}: {
  draft: ProviderSettingsDraft;
  onChange: (patch: Partial<ProviderSettingsDraft>) => void;
  baseUrlRequired: boolean;
}) {
  return (
    <>
      <Field label="Base URL" hint={baseUrlRequired ? undefined : "Leave blank for the default."}>
        <Input
          type="url"
          required={baseUrlRequired}
          value={draft.base_url}
          onChange={(e) => onChange({ base_url: e.target.value })}
        />
      </Field>
      <Field label="Credential strategy" hint={STRATEGY_HINTS[draft.key_strategy]}>
        <Select
          value={draft.key_strategy}
          onChange={(e) => onChange({ key_strategy: e.target.value as Strategy })}
        >
          {STRATEGIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sticky TTL (seconds)" hint="0 = no session pinning">
          <Input
            type="number"
            required
            min={0}
            max={86400}
            step={1}
            value={draft.sticky_ttl_sec}
            onChange={(e) => onChange({ sticky_ttl_sec: e.target.value })}
          />
        </Field>
        <Field label="Max attempts" hint="Credentials tried per request">
          <Input
            type="number"
            required
            min={1}
            max={20}
            step={1}
            value={draft.max_key_attempts}
            onChange={(e) => onChange({ max_key_attempts: e.target.value })}
          />
        </Field>
      </div>
      <Checkbox
        label="Enabled"
        checked={draft.enabled}
        onChange={(e) => onChange({ enabled: e.target.checked })}
      />
    </>
  );
}
