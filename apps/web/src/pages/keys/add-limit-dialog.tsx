import { createModal } from "@buiducnhat/better-modal";
import { useState, type FormEvent } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { LimitInput, VirtualKey } from "@/api/types";
import { FormError } from "@/components/form-error";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { emptyLimitDraft, validateLimit } from "@/lib/limits";
import { LimitFields } from "./limit-fields";

type Props = { apiKey: VirtualKey };

function AddLimitForm({
  apiKey,
  onDone,
}: {
  apiKey: VirtualKey;
  onDone: (added: boolean) => void;
}) {
  const [draft, setDraft] = useState(emptyLimitDraft);
  const [problem, setProblem] = useState<string | null>(null);
  const add = useAction((limit: LimitInput) => api.addLimit(apiKey.id, limit), {
    invalidate: [qk.keys],
    inline: true,
    success: "Limit added.",
    onSuccess: () => onDone(true),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = validateLimit(draft);
    setProblem(result.ok ? null : result.error);
    if (result.ok) add.mutate(result.limit);
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <LimitFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
      <FormError error={problem ?? add.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={add.isPending}>
          {add.isPending && <Spinner data-icon="inline-start" />}
          Add limit
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Resolves `true` once the limit was added, `false` if dismissed. */
export const AddLimitModal = createModal<Props, boolean>("add-limit", ({ apiKey, modal }) => (
  <ModalDialog
    modal={modal}
    dismissed={false}
    title={`Add limit to ${apiKey.name}`}
    description="Cap spend or usage for this key over a fixed or rolling window."
    wide
  >
    <AddLimitForm apiKey={apiKey} onDone={modal.resolve} />
  </ModalDialog>
));
