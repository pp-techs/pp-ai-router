import { createModal } from "@buiducnhat/better-modal";
import { useState, type FormEvent } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { KeyPatch, VirtualKey } from "@/api/types";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatList, fromDatetimeLocal, parseList, toDatetimeLocal } from "@/lib/input";

type Props = { apiKey: VirtualKey };

function EditKeyForm({ apiKey, onDone }: { apiKey: VirtualKey; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState(apiKey.name);
  const [models, setModels] = useState(formatList(apiKey.allowed_models));
  const [expiry, setExpiry] = useState(toDatetimeLocal(apiKey.expires_at));

  const save = useAction((patch: KeyPatch) => api.updateKey(apiKey.id, patch), {
    invalidate: [qk.keys],
    inline: true,
    success: "API key updated.",
    onSuccess: () => onDone(true),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate({
      name: name.trim(),
      allowed_models: parseList(models),
      expires_at: fromDatetimeLocal(expiry),
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
      <FormError error={save.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Resolves `true` once saved, `false` if dismissed. */
export const EditKeyModal = createModal<Props, boolean>("edit-key", ({ apiKey, modal }) => (
  <ModalDialog
    modal={modal}
    dismissed={false}
    title={`Edit ${apiKey.name}`}
    description="Rename the key or change its model access and expiry. The secret stays the same."
    wide
  >
    <EditKeyForm apiKey={apiKey} onDone={modal.resolve} />
  </ModalDialog>
));
