import { createModal } from "@buiducnhat/better-modal";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Provider } from "@/api/types";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { ModalDialog } from "@/components/modal-dialog";
import { OptionSelect } from "@/components/option-select";
import { LoadingState } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ProviderSettingsFields, type ProviderSettingsDraft } from "./provider-fields";

const ID_PATTERN = "[a-z0-9][a-z0-9_\\-]{0,62}";

type CreateProps = Record<string, unknown>;

/** Add a provider, then open it. Resolves `true` once created, `false` if dismissed. */
export const CreateProviderModal = createModal<CreateProps, boolean>(
  "create-provider",
  ({ modal }) => (
    <ModalDialog modal={modal} dismissed={false} title="Add provider">
      <CreateProviderForm
        onDone={() => modal.resolve(true)}
        onCancel={() => modal.resolve(false)}
      />
    </ModalDialog>
  ),
);

function CreateProviderForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const navigate = useNavigate();
  const types = useQuery({ queryKey: qk.providerTypes, queryFn: api.providerTypes });
  const [typeChoice, setTypeChoice] = useState<string | null>(null);
  // null = "untouched": show the type's default (and let the server apply it).
  const [idEdit, setIdEdit] = useState<string | null>(null);
  const [baseUrlEdit, setBaseUrlEdit] = useState<string | null>(null);
  const [settings, setSettings] = useState<Omit<ProviderSettingsDraft, "base_url">>({
    key_strategy: "round_robin",
    sticky_ttl_sec: "0",
    max_key_attempts: "3",
    enabled: true,
  });

  const selected = types.data?.find((t) => t.type === typeChoice) ?? types.data?.[0];
  const defaultUrl = selected?.default_base_url ?? "";

  const create = useAction(api.createProvider, {
    invalidate: [qk.providers],
    inline: true,
    success: (_, body) => `Provider "${body.id}" created.`,
    onSuccess: (_, body) => {
      onDone();
      void navigate(`/providers/${encodeURIComponent(body.id)}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const baseUrl = baseUrlEdit?.trim();
    create.mutate({
      id: (idEdit ?? selected.type).trim(),
      type: selected.type,
      ...(baseUrl && { base_url: baseUrl }),
      key_strategy: settings.key_strategy,
      sticky_ttl_sec: Number(settings.sticky_ttl_sec),
      max_key_attempts: Number(settings.max_key_attempts),
      enabled: settings.enabled,
    });
  }

  if (types.isPending) return <LoadingState />;
  if (types.isError) return <FormError error={types.error} />;

  return (
    <form onSubmit={submit} className="grid gap-4">
      <FormField label="Type">
        <OptionSelect
          value={selected?.type ?? ""}
          onValueChange={(value) => {
            setTypeChoice(value);
            setBaseUrlEdit(null);
          }}
          options={types.data.map((t) => ({ value: t.type, label: t.label }))}
        />
      </FormField>
      <FormField
        label="ID"
        hint="Used in model names: <id>/<model>. Lowercase letters, digits, - and _."
      >
        <Input
          required
          pattern={ID_PATTERN}
          maxLength={63}
          value={idEdit ?? selected?.type ?? ""}
          onChange={(e) => setIdEdit(e.target.value)}
        />
      </FormField>
      <ProviderSettingsFields
        draft={{ ...settings, base_url: baseUrlEdit ?? defaultUrl }}
        onChange={({ base_url, ...rest }) => {
          if (base_url !== undefined) setBaseUrlEdit(base_url);
          setSettings((s) => ({ ...s, ...rest }));
        }}
        baseUrlRequired={selected?.default_base_url === null}
      />
      <FormError error={create.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending && <Spinner data-icon="inline-start" />}
          Create provider
        </Button>
      </DialogFooter>
    </form>
  );
}

type EditProps = { provider: Provider };

/** Edit a provider's settings. Resolves `true` once saved, `false` if dismissed. */
export const EditProviderModal = createModal<EditProps, boolean>(
  "edit-provider",
  ({ provider, modal }) => (
    <ModalDialog modal={modal} dismissed={false} title={`Edit ${provider.id}`}>
      <EditProviderForm
        provider={provider}
        onDone={() => modal.resolve(true)}
        onCancel={() => modal.resolve(false)}
      />
    </ModalDialog>
  ),
);

function EditProviderForm({
  provider,
  onDone,
  onCancel,
}: {
  provider: Provider;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [settings, setSettings] = useState<ProviderSettingsDraft>({
    base_url: provider.base_url,
    key_strategy: provider.key_strategy,
    sticky_ttl_sec: String(provider.sticky_ttl_sec),
    max_key_attempts: String(provider.max_key_attempts),
    enabled: provider.enabled,
  });
  const update = useAction(
    (draft: ProviderSettingsDraft) =>
      api.updateProvider(provider.id, {
        base_url: draft.base_url.trim(),
        key_strategy: draft.key_strategy,
        sticky_ttl_sec: Number(draft.sticky_ttl_sec),
        max_key_attempts: Number(draft.max_key_attempts),
        enabled: draft.enabled,
      }),
    {
      invalidate: [qk.providers],
      inline: true,
      success: "Provider updated.",
      onSuccess: onDone,
    },
  );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(settings);
      }}
    >
      <ProviderSettingsFields
        draft={settings}
        onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        baseUrlRequired
      />
      <FormError error={update.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending && <Spinner data-icon="inline-start" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
