import { useState } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { Price } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { Dialog, DialogActions } from "../../components/dialog.tsx";
import { Field, FormError, Input } from "../../components/fields.tsx";
import { optionalNumber } from "../../lib/input.ts";

/** Model + four per-1M fields; null `base` means a blank form. Cache prices are optional. */
export function OverrideDialog({ base, onClose }: { base: Price | null; onClose: () => void }) {
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
      onSuccess: onClose,
    },
  );

  const price = { type: "number", min: 0, max: 1_000_000, step: "any" } as const;

  return (
    <Dialog
      title={base?.source === "override" ? `Edit override` : "New price override"}
      onClose={onClose}
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Model" hint="The model name as the router bills it (the upstream model).">
          <Input
            required
            value={model}
            readOnly={base?.source === "override"}
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Input, USD per 1M tokens">
            <Input {...price} required value={input} onChange={(e) => setInput(e.target.value)} />
          </Field>
          <Field label="Output, USD per 1M tokens">
            <Input {...price} required value={output} onChange={(e) => setOutput(e.target.value)} />
          </Field>
          <Field label="Cache read per 1M (optional)">
            <Input {...price} value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} />
          </Field>
          <Field label="Cache write per 1M (optional)">
            <Input {...price} value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} />
          </Field>
        </div>
        <FormError error={save.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save override
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
