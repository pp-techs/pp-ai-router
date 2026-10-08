import { STRATEGIES, type Strategy } from "@/api/types";
import { FormField } from "@/components/form-field";
import { OptionSelect } from "@/components/option-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ProviderSettingsDraft = {
  base_url: string;
  key_strategy: Strategy;
  sticky_ttl_sec: string;
  max_key_attempts: string;
  enabled: boolean;
};

const STRATEGY_HINTS: Record<Strategy, string> = {
  round_robin: "Rotate through the credentials in turn.",
  weighted: "Interleave picks in proportion to each credential's weight.",
  least_inflight: "The credential with the fewest requests in flight.",
  least_used: "The credential with the fewest recent tokens per unit of weight.",
  fill_first: "The lowest priority number first; others only when it is unavailable.",
  random: "A uniformly random credential.",
};

const STRATEGY_LABELS: Record<Strategy, string> = {
  round_robin: "Round robin",
  weighted: "Weighted",
  least_inflight: "Least in flight",
  least_used: "Least used",
  fill_first: "Fill first",
  random: "Random",
};

const STRATEGY_OPTIONS = STRATEGIES.map((s) => ({ value: s, label: STRATEGY_LABELS[s] }));

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
      <FormField
        label="Base URL"
        hint={baseUrlRequired ? undefined : "Leave blank for the default."}
      >
        <Input
          type="url"
          required={baseUrlRequired}
          value={draft.base_url}
          onChange={(e) => onChange({ base_url: e.target.value })}
        />
      </FormField>
      <FormField label="Credential strategy" hint={STRATEGY_HINTS[draft.key_strategy]}>
        <OptionSelect
          value={draft.key_strategy}
          onValueChange={(v) => onChange({ key_strategy: v as Strategy })}
          options={STRATEGY_OPTIONS}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Sticky TTL (seconds)" hint="0 = no session pinning">
          <Input
            type="number"
            required
            min={0}
            max={86400}
            step={1}
            value={draft.sticky_ttl_sec}
            onChange={(e) => onChange({ sticky_ttl_sec: e.target.value })}
          />
        </FormField>
        <FormField label="Max attempts" hint="Credentials tried per request">
          <Input
            type="number"
            required
            min={1}
            max={20}
            step={1}
            value={draft.max_key_attempts}
            onChange={(e) => onChange({ max_key_attempts: e.target.value })}
          />
        </FormField>
      </div>
      <Label>
        <Checkbox
          checked={draft.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
        />
        Enabled
      </Label>
    </>
  );
}
