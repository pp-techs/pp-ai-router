import { createModal } from "@buiducnhat/better-modal";
import { useState, type FormEvent } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { CreatedKey, LimitInput } from "@/api/types";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { fromDatetimeLocal, parseList } from "@/lib/input";
import { emptyLimitDraft, validateLimit, type LimitDraft } from "@/lib/limits";
import { LimitFields } from "./limit-fields";

function CreateKeyForm({ onDone }: { onDone: (key: CreatedKey | null) => void }) {
  const [name, setName] = useState("");
  const [models, setModels] = useState("");
  const [expiry, setExpiry] = useState("");
  const [limits, setLimits] = useState<LimitDraft[]>([]);
  const [limitErrors, setLimitErrors] = useState<(string | null)[]>([]);

  const create = useAction(api.createKey, {
    invalidate: [qk.keys],
    inline: true,
    onSuccess: onDone,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const results = limits.map(validateLimit);
    setLimitErrors(results.map((r) => (r.ok ? null : r.error)));
    if (!results.every((r) => r.ok)) return;
    create.mutate({
      name: name.trim(),
      allowed_models: parseList(models),
      expires_at: fromDatetimeLocal(expiry),
      limits: results.flatMap((r): LimitInput[] => (r.ok ? [r.limit] : [])),
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name" hint="Who or what uses this key.">
          <Input
            required
            autoFocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>
        <FormField label="Expires (optional)" hint="Your local time. Blank = never.">
          <Input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </FormField>
      </div>
      <FormField
        label="Allowed models"
        hint="Globs matched against the requested model, e.g. fast, gpt-*. Blank = any model."
      >
        <Input value={models} placeholder="*" onChange={(e) => setModels(e.target.value)} />
      </FormField>

      <FieldSet>
        <FieldLegend variant="label">Limits</FieldLegend>
        {limits.length === 0 && (
          <p className="text-muted-foreground">No limits: this key is unrestricted.</p>
        )}
        {limits.map((draft, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-border p-3">
            <LimitFields
              draft={draft}
              onChange={(patch) => {
                setLimits((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));
                setLimitErrors((errors) => errors.map((e, j) => (j === i ? null : e)));
              }}
            />
            <div className="flex items-center justify-between gap-3">
              {limitErrors[i] ? <FormError error={limitErrors[i]} /> : <span />}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setLimits((list) => list.filter((_, j) => j !== i));
                  setLimitErrors([]);
                }}
              >
                Remove limit
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={limits.length >= 20}
            onClick={() => setLimits((l) => [...l, emptyLimitDraft()])}
          >
            Add limit
          </Button>
        </div>
      </FieldSet>

      <FormError error={create.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending && <Spinner data-icon="inline-start" />}
          Create key
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Resolves the created key, or `null` if dismissed. */
export const CreateKeyModal = createModal<Record<string, unknown>, CreatedKey | null>(
  "create-key",
  ({ modal }) => (
    <ModalDialog modal={modal} dismissed={null} title="Create API key" wide>
      <CreateKeyForm onDone={modal.resolve} />
    </ModalDialog>
  ),
);
