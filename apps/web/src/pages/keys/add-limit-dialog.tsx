import { useState, type FormEvent } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { LimitInput, VirtualKey } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { Dialog, DialogActions } from "../../components/dialog.tsx";
import { FormError } from "../../components/fields.tsx";
import { emptyLimitDraft, validateLimit } from "../../lib/limits.ts";
import { LimitFields } from "./limit-fields.tsx";

export function AddLimitDialog({ apiKey, onClose }: { apiKey: VirtualKey; onClose: () => void }) {
  const [draft, setDraft] = useState(emptyLimitDraft);
  const [problem, setProblem] = useState<string | null>(null);
  const add = useAction((limit: LimitInput) => api.addLimit(apiKey.id, limit), {
    invalidate: [qk.keys],
    inline: true,
    success: "Limit added.",
    onSuccess: onClose,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = validateLimit(draft);
    setProblem(result.ok ? null : result.error);
    if (result.ok) add.mutate(result.limit);
  }

  return (
    <Dialog title={`Add limit to ${apiKey.name}`} onClose={onClose} wide>
      <form onSubmit={submit} className="grid gap-4">
        <LimitFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <FormError error={problem ?? add.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending}>
            Add limit
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
