import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { api } from "../api/client.ts";
import { qk } from "../api/queries.ts";
import { Input } from "./fields.tsx";

/**
 * Model id field backed by a provider's known models (native `<datalist>`). It stays free text:
 * any `provider/<id>` is routable even when the provider does not list it. The list is fetched
 * lazily for the chosen provider, and a failed fetch just leaves a plain input.
 */
export function ModelInput({
  label,
  providerId,
  value,
  onChange,
}: {
  label: string;
  providerId: string;
  value: string;
  onChange: (model: string) => void;
}) {
  const listId = useId();
  const models = useQuery({
    queryKey: qk.providerModels(providerId),
    queryFn: () => api.providerModels(providerId),
    enabled: providerId !== "",
    staleTime: 60_000,
    retry: false,
  });
  const count = models.data?.data.length ?? 0;

  return (
    <>
      <Input
        required
        list={listId}
        autoComplete="off"
        aria-label={label}
        placeholder={
          models.isPending && providerId !== ""
            ? "loading models…"
            : count > 0
              ? `pick one of ${count} models or type an id`
              : "upstream model id, e.g. gpt-4o-mini"
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {models.data?.data.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name ?? ""}
          </option>
        ))}
      </datalist>
    </>
  );
}
