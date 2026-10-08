import { createModal } from "@buiducnhat/better-modal";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Price } from "@/api/types";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { optionalNumber } from "@/lib/input";

type OverrideModalProps = {
  /** Null means a blank form. */
  base: Price | null;
};

function OverrideForm({
  base,
  modal,
}: {
  base: Price | null;
  modal: { resolve: (v: boolean) => void };
}) {
  const text = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const [model, setModel] = useState(base?.model ?? "");
  const [input, setInput] = useState(text(base?.input_per_1m));
  const [output, setOutput] = useState(text(base?.output_per_1m));
  const [cacheRead, setCacheRead] = useState(text(base?.cache_read_per_1m));
  const [cacheWrite, setCacheWrite] = useState(text(base?.cache_write_per_1m));

  const save = useAction(
    () => {
      const read = optionalNumber(cacheRead);
      const write = optionalNumber(cacheWrite);
      return api.putOverride({
        model: model.trim(),
        input_per_1m: Number(input),
        output_per_1m: Number(output),
        ...(read !== null && { cache_read_per_1m: read }),
        ...(write !== null && { cache_write_per_1m: write }),
      });
    },
    {
      invalidate: [qk.pricing],
      inline: true,
      success: "Override saved.",
      onSuccess: () => modal.resolve(true),
    },
  );

  const price = { type: "number", min: 0, max: 1_000_000, step: "any" } as const;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <FormField label="Model" hint="The model name as the router bills it (the upstream model).">
        <Input
          required
          autoFocus={base?.source !== "override"}
          value={model}
          readOnly={base?.source === "override"}
          onChange={(e) => setModel(e.target.value)}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Input, USD per 1M tokens">
          <Input {...price} required value={input} onChange={(e) => setInput(e.target.value)} />
        </FormField>
        <FormField label="Output, USD per 1M tokens">
          <Input {...price} required value={output} onChange={(e) => setOutput(e.target.value)} />
        </FormField>
        <FormField label="Cache read per 1M (optional)">
          <Input {...price} value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} />
        </FormField>
        <FormField label="Cache write per 1M (optional)">
          <Input {...price} value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} />
        </FormField>
      </div>
      <FormError error={save.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => modal.resolve(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          Save override
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Model + four per-1M fields. Resolves `true` once saved. */
export const OverrideModal = createModal<OverrideModalProps, boolean>(
  "price-override",
  ({ base, modal }) => (
    <ModalDialog
      modal={modal}
      dismissed={false}
      title={base?.source === "override" ? "Edit override" : "New price override"}
    >
      <OverrideForm base={base} modal={modal} />
    </ModalDialog>
  ),
);
