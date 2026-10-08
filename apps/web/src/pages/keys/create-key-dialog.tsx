import { useState, type FormEvent } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { CreatedKey, LimitInput } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { Dialog, DialogActions } from "../../components/dialog.tsx";
import { Field, FormError, Input } from "../../components/fields.tsx";
import { fromDatetimeLocal, parseList } from "../../lib/input.ts";
import { emptyLimitDraft, validateLimit, type LimitDraft } from "../../lib/limits.ts";
import { LimitFields } from "./limit-fields.tsx";

export function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: CreatedKey) => void;
}) {
  const [name, setName] = useState("");
  const [models, setModels] = useState("");
  const [expiry, setExpiry] = useState("");
  const [limits, setLimits] = useState<LimitDraft[]>([]);
  const [limitErrors, setLimitErrors] = useState<(string | null)[]>([]);

  const create = useAction(api.createKey, {
    invalidate: [qk.keys],
    inline: true,
    onSuccess: onCreated,
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
    <Dialog title="Create API key" onClose={onClose} wide>
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="Who or what uses this key.">
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Expires (optional)" hint="Your local time. Blank = never.">
            <Input
              type="datetime-local"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Allowed models"
          hint="Globs matched against the requested model, e.g. fast, gpt-*. Blank = any model."
        >
          <Input value={models} placeholder="*" onChange={(e) => setModels(e.target.value)} />
        </Field>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-xs font-medium text-muted">Limits</legend>
          {limits.length === 0 && (
            <p className="text-muted">No limits: this key is unrestricted.</p>
          )}
          {limits.map((draft, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-line p-3">
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
                  small
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
              small
              disabled={limits.length >= 20}
              onClick={() => setLimits((l) => [...l, emptyLimitDraft()])}
            >
              Add limit
            </Button>
          </div>
        </fieldset>

        <FormError error={create.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create key
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
