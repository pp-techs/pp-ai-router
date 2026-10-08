import { Checkbox, Field, Input } from "../../components/fields.tsx";
import type { CredentialDraft } from "../../lib/credential-draft.ts";

/** Shared by the add-key, edit and OAuth-login dialogs. */
export function CredentialFields({
  draft,
  onChange,
  labelRequired = true,
  showEnabled = true,
}: {
  draft: CredentialDraft;
  onChange: (patch: Partial<CredentialDraft>) => void;
  labelRequired?: boolean;
  showEnabled?: boolean;
}) {
  return (
    <>
      <Field
        label={labelRequired ? "Label" : "Label (optional)"}
        hint={labelRequired ? undefined : "Defaults to the account's email."}
      >
        <Input
          required={labelRequired}
          maxLength={100}
          value={draft.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Weight" hint="1–1000">
          <Input
            type="number"
            required
            min={1}
            max={1000}
            step={1}
            value={draft.weight}
            onChange={(e) => onChange({ weight: e.target.value })}
          />
        </Field>
        <Field label="Priority" hint="Lower = first">
          <Input
            type="number"
            required
            min={-1000}
            max={1000}
            step={1}
            value={draft.priority}
            onChange={(e) => onChange({ priority: e.target.value })}
          />
        </Field>
        <Field label="RPM limit" hint="Blank = none">
          <Input
            type="number"
            min={1}
            step={1}
            value={draft.rpm}
            onChange={(e) => onChange({ rpm: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Model globs" hint="Comma separated, e.g. gpt-*, o1. Blank = all models.">
        <Input
          value={draft.models}
          placeholder="*"
          onChange={(e) => onChange({ models: e.target.value })}
        />
      </Field>
      {showEnabled && (
        <Checkbox
          label="Enabled"
          checked={draft.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
      )}
    </>
  );
}
