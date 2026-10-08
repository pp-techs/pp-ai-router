import { useState } from "react";
import { api } from "../api/client.ts";
import { qk, useAction } from "../api/queries.ts";
import type { Alias, AliasTarget, Provider } from "../api/types.ts";
import { Button } from "../components/button.tsx";
import { Dialog, DialogActions } from "../components/dialog.tsx";
import { Field, FormError, Input, Select } from "../components/fields.tsx";
import { ModelInput } from "../components/model-input.tsx";

/** Create or edit an alias. `firstTarget` prefills the first target of a new alias (e.g. from a provider's model list). */
export function AliasDialog({
  alias,
  firstTarget,
  providers,
  onClose,
}: {
  alias: Alias | null;
  firstTarget?: AliasTarget;
  providers: Provider[];
  onClose: () => void;
}) {
  const [name, setName] = useState(alias?.alias ?? "");
  const [targets, setTargets] = useState<AliasTarget[]>(
    alias?.targets ?? [firstTarget ?? { provider: providers[0]?.id ?? "", model: "" }],
  );
  const save = useAction(() => api.putAlias(name.trim(), targets), {
    invalidate: [qk.aliases],
    inline: true,
    success: "Alias saved.",
    onSuccess: onClose,
  });

  const patch = (index: number, change: Partial<AliasTarget>) =>
    setTargets((list) => list.map((t, i) => (i === index ? { ...t, ...change } : t)));
  const move = (index: number, delta: -1 | 1) =>
    setTargets((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });

  return (
    <Dialog title={alias ? `Edit ${alias.alias}` : "New alias"} onClose={onClose} wide>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Alias" hint="The model name clients send, e.g. fast or gpt-4o.">
          <Input
            required
            readOnly={alias !== null}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-xs font-medium text-muted">
            Targets (tried in this order)
          </legend>
          {targets.map((t, i) => (
            <div key={i} className="grid grid-cols-[1.5rem_1fr_1.4fr_auto] items-center gap-2">
              <span className="text-center text-muted tabular-nums">{i + 1}</span>
              <Select
                aria-label={`Target ${i + 1} provider`}
                value={t.provider}
                onChange={(e) => patch(i, { provider: e.target.value })}
              >
                {/* A target may point at a provider that has since been deleted; keep it visible. */}
                {!providers.some((p) => p.id === t.provider) && (
                  <option value={t.provider}>{t.provider} (missing)</option>
                )}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </Select>
              <ModelInput
                label={`Target ${i + 1} model`}
                providerId={t.provider}
                value={t.model}
                onChange={(model) => patch(i, { model })}
              />
              <div className="flex gap-1">
                <Button
                  small
                  variant="ghost"
                  aria-label={`Move target ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </Button>
                <Button
                  small
                  variant="ghost"
                  aria-label={`Move target ${i + 1} down`}
                  disabled={i === targets.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </Button>
                <Button
                  small
                  variant="ghost"
                  aria-label={`Remove target ${i + 1}`}
                  disabled={targets.length === 1}
                  onClick={() => setTargets((l) => l.filter((_, j) => j !== i))}
                >
                  ✕
                </Button>
              </div>
            </div>
          ))}
          <div>
            <Button
              small
              disabled={targets.length >= 20}
              onClick={() =>
                setTargets((l) => [...l, { provider: providers[0]?.id ?? "", model: "" }])
              }
            >
              Add fallback target
            </Button>
          </div>
        </fieldset>

        <FormError error={save.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save alias
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
