import { createModal } from "@buiducnhat/better-modal";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Alias, AliasTarget, Provider } from "@/api/types";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { ModalDialog } from "@/components/modal-dialog";
import { ModelInput } from "@/components/model-input";
import { OptionSelect } from "@/components/option-select";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type AliasModalProps = {
  alias: Alias | null;
  /** Prefills the first target of a new alias (e.g. from a provider's model list). */
  firstTarget?: AliasTarget;
  providers: Provider[];
};

function AliasForm({
  alias,
  firstTarget,
  providers,
  modal,
}: AliasModalProps & { modal: { resolve: (v: boolean) => void } }) {
  const [name, setName] = useState(alias?.alias ?? "");
  const [targets, setTargets] = useState<AliasTarget[]>(
    alias?.targets ?? [firstTarget ?? { provider: providers[0]?.id ?? "", model: "" }],
  );
  const save = useAction(() => api.putAlias(name.trim(), targets), {
    invalidate: [qk.aliases],
    inline: true,
    success: "Alias saved.",
    onSuccess: () => modal.resolve(true),
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
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <FormField label="Alias" hint="The model name clients send, e.g. fast or gpt-4o.">
        <Input
          required
          autoFocus={alias === null}
          readOnly={alias !== null}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </FormField>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          Targets (tried in this order)
        </legend>
        {targets.map((t, i) => (
          <div key={i} className="grid grid-cols-[1.5rem_1fr_1.4fr_auto] items-center gap-2">
            <span className="text-center text-muted-foreground tabular-nums">{i + 1}</span>
            <OptionSelect
              aria-label={`Target ${i + 1} provider`}
              value={t.provider}
              onValueChange={(provider) => patch(i, { provider })}
              options={[
                // A target may point at a provider that has since been deleted; keep it visible.
                ...(providers.some((p) => p.id === t.provider)
                  ? []
                  : [{ value: t.provider, label: `${t.provider} (missing)` }]),
                ...providers.map((p) => ({ value: p.id, label: p.id })),
              ]}
            />
            <ModelInput
              label={`Target ${i + 1} model`}
              providerId={t.provider}
              value={t.model}
              onChange={(model) => patch(i, { model })}
            />
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Move target ${i + 1} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Move target ${i + 1} down`}
                disabled={i === targets.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </Button>
              <Button
                type="button"
                size="sm"
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
            type="button"
            size="sm"
            variant="outline"
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
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => modal.resolve(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          Save alias
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Create or edit an alias. Resolves `true` once saved. */
export const AliasModal = createModal<AliasModalProps, boolean>(
  "alias-editor",
  ({ alias, firstTarget, providers, modal }) => (
    <ModalDialog
      modal={modal}
      dismissed={false}
      wide
      title={alias ? `Edit ${alias.alias}` : "New alias"}
    >
      <AliasForm alias={alias} firstTarget={firstTarget} providers={providers} modal={modal} />
    </ModalDialog>
  ),
);
