import { createModal } from "@buiducnhat/better-modal";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { ProviderModel } from "@/api/types";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { ModalDialog } from "@/components/modal-dialog";
import { OptionSelect } from "@/components/option-select";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatList, optionalNumber, parseList } from "@/lib/input";

type CustomModelProps = {
  /** Providers a new model can be added to. */
  providers: string[];
  /** Preselected provider for a new model. */
  provider: string | null;
  /** The custom model being edited; null adds a new one. */
  model: { provider: string; model: ProviderModel } | null;
};

const text = (v: string | number | null | undefined) =>
  v === null || v === undefined ? "" : String(v);
const toDate = (seconds: number | null) =>
  seconds === null ? "" : new Date(seconds * 1000).toISOString().slice(0, 10);
const fromDate = (value: string) =>
  value ? Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000) : null;
const orNull = (value: string) => value.trim() || null;

function CustomModelForm({
  providers,
  provider: initialProvider,
  model: editing,
  modal,
}: CustomModelProps & { modal: { resolve: (v: boolean) => void } }) {
  const base = editing?.model ?? null;
  const [provider, setProvider] = useState(
    editing?.provider ?? initialProvider ?? providers[0] ?? "",
  );
  const [id, setId] = useState(base?.id ?? "");
  const [name, setName] = useState(text(base?.name));
  const [description, setDescription] = useState(text(base?.description));
  const [context, setContext] = useState(text(base?.context_window));
  const [maxOutput, setMaxOutput] = useState(text(base?.max_output_tokens));
  const [released, setReleased] = useState(toDate(base?.created ?? null));
  const [inputs, setInputs] = useState(formatList(base?.input_modalities ?? null));
  const [outputs, setOutputs] = useState(formatList(base?.output_modalities ?? null));
  const [params, setParams] = useState(formatList(base?.supported_parameters ?? null));

  const save = useAction(
    () =>
      api.putCustomModel(provider, id.trim(), {
        name: orNull(name),
        description: orNull(description),
        created: fromDate(released),
        context_window: optionalNumber(context),
        max_output_tokens: optionalNumber(maxOutput),
        input_modalities: parseList(inputs),
        output_modalities: parseList(outputs),
        supported_parameters: parseList(params),
      }),
    {
      invalidate: [qk.models, qk.providerModels(provider)],
      inline: true,
      success: base ? "Model saved." : "Model added.",
      onSuccess: () => modal.resolve(true),
    },
  );

  const count = { type: "number", min: 1, step: 1 } as const;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Provider">
          {editing ? (
            <Input readOnly value={provider} className="font-mono" />
          ) : (
            <OptionSelect
              aria-label="Provider"
              value={provider}
              onValueChange={setProvider}
              options={providers.map((p) => ({ value: p, label: p }))}
            />
          )}
        </FormField>
        <FormField
          label="Model id"
          hint="What follows provider/ in requests. It replaces a listed model of the same id."
        >
          <Input
            required
            autoFocus={!editing}
            readOnly={!!editing}
            maxLength={500}
            value={id}
            className="font-mono"
            onChange={(e) => setId(e.target.value)}
          />
        </FormField>
      </div>
      <FormField label="Display name (optional)">
        <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label="Description (optional)">
        <Textarea
          rows={2}
          maxLength={5000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Context window">
          <Input
            {...count}
            placeholder="tokens"
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        </FormField>
        <FormField label="Max output">
          <Input
            {...count}
            placeholder="tokens"
            value={maxOutput}
            onChange={(e) => setMaxOutput(e.target.value)}
          />
        </FormField>
        <FormField label="Release date">
          <Input type="date" value={released} onChange={(e) => setReleased(e.target.value)} />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          label="Input modalities"
          hint="Comma separated: text, image, audio, video, file."
        >
          <Input
            value={inputs}
            placeholder="text, image"
            onChange={(e) => setInputs(e.target.value)}
          />
        </FormField>
        <FormField label="Output modalities">
          <Input value={outputs} placeholder="text" onChange={(e) => setOutputs(e.target.value)} />
        </FormField>
      </div>
      <FormField
        label="Supported parameters"
        hint="Comma separated, e.g. tools, temperature, reasoning, structured_outputs. Set a price from the model's row menu."
      >
        <Textarea
          rows={2}
          className="font-mono"
          value={params}
          placeholder="tools, temperature, max_tokens"
          onChange={(e) => setParams(e.target.value)}
        />
      </FormField>
      <FormError error={save.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => modal.resolve(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending || !provider || !id.trim()}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          {base ? "Save model" : "Add model"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Add or edit a hand-made model with every fact a listed model carries. Resolves `true` once saved. */
export const CustomModelModal = createModal<CustomModelProps, boolean>(
  "custom-model",
  ({ modal, ...props }) => (
    <ModalDialog
      modal={modal}
      dismissed={false}
      wide
      title={props.model ? "Edit custom model" : "Add custom model"}
      description="Not listed by the provider? Add it by hand. It joins the provider's list, is offered on /v1/models and survives refreshes."
    >
      <CustomModelForm {...props} modal={modal} />
    </ModalDialog>
  ),
);
