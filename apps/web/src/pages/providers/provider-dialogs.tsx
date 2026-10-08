import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { Provider } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { Dialog, DialogActions } from "../../components/dialog.tsx";
import { Field, FormError, Input, Select } from "../../components/fields.tsx";
import { LoadingState } from "../../components/query-state.tsx";
import { ProviderSettingsFields, type ProviderSettingsDraft } from "./provider-fields.tsx";

const ID_PATTERN = "[a-z0-9][a-z0-9_\\-]{0,62}";

export function CreateProviderDialog({ onClose }: { onClose: () => void }) {
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
      onClose();
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

  return (
    <Dialog title="Add provider" onClose={onClose}>
      {types.isPending ? (
        <LoadingState />
      ) : types.isError ? (
        <FormError error={types.error} />
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Type">
            <Select
              value={selected?.type ?? ""}
              onChange={(e) => {
                setTypeChoice(e.target.value);
                setBaseUrlEdit(null);
              }}
            >
              {types.data.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
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
          </Field>
          <ProviderSettingsFields
            draft={{ ...settings, base_url: baseUrlEdit ?? defaultUrl }}
            onChange={({ base_url, ...rest }) => {
              if (base_url !== undefined) setBaseUrlEdit(base_url);
              setSettings((s) => ({ ...s, ...rest }));
            }}
            baseUrlRequired={selected?.default_base_url === null}
          />
          <FormError error={create.error} />
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create provider
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}

export function EditProviderDialog({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose: () => void;
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
      onSuccess: onClose,
    },
  );

  return (
    <Dialog title={`Edit ${provider.id}`} onClose={onClose}>
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
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={update.isPending}>
            Save
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
