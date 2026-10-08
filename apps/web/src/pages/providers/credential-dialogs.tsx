import { createModal } from "@buiducnhat/better-modal";
import { useState } from "react";
import { api } from "@/api/client";
import { qk, useAction } from "@/api/queries";
import type { Credential } from "@/api/types";
import { FormError } from "@/components/form-error";
import { FormField } from "@/components/form-field";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  draftFromCredential,
  draftToBody,
  emptyCredentialDraft,
  type CredentialDraft,
} from "@/lib/credential-draft";
import { CredentialFields } from "./credential-fields";

type AddProps = { providerId: string };

/** Add an API key to a provider. Resolves `true` once added, `false` if dismissed. */
export const AddCredentialModal = createModal<AddProps, boolean>(
  "add-credential",
  ({ providerId, modal }) => (
    <ModalDialog modal={modal} dismissed={false} title="Add API key">
      <AddCredentialForm
        providerId={providerId}
        onDone={() => modal.resolve(true)}
        onCancel={() => modal.resolve(false)}
      />
    </ModalDialog>
  ),
);

function AddCredentialForm({
  providerId,
  onDone,
  onCancel,
}: {
  providerId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CredentialDraft>(emptyCredentialDraft);
  const [secret, setSecret] = useState("");
  const create = useAction(
    () => api.createCredential(providerId, { ...draftToBody(draft), secret }),
    {
      invalidate: [qk.providers],
      inline: true,
      success: "Credential added.",
      onSuccess: onDone,
    },
  );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <FormField
        label="API key"
        hint="Stored encrypted; only the last 4 characters are shown afterwards."
      >
        <Input
          type="password"
          required
          autoFocus
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </FormField>
      <CredentialFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
      <FormError error={create.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending && <Spinner data-icon="inline-start" />}
          Add credential
        </Button>
      </DialogFooter>
    </form>
  );
}

type CredentialProps = { credential: Credential };

/** Edit a credential's settings. Resolves `true` once saved, `false` if dismissed. */
export const EditCredentialModal = createModal<CredentialProps, boolean>(
  "edit-credential",
  ({ credential, modal }) => (
    <ModalDialog modal={modal} dismissed={false} title={`Edit ${credential.label}`}>
      <EditCredentialForm
        credential={credential}
        onDone={() => modal.resolve(true)}
        onCancel={() => modal.resolve(false)}
      />
    </ModalDialog>
  ),
);

function EditCredentialForm({
  credential,
  onDone,
  onCancel,
}: {
  credential: Credential;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFromCredential(credential));
  const update = useAction(() => api.updateCredential(credential.id, draftToBody(draft)), {
    invalidate: [qk.providers],
    inline: true,
    success: "Credential updated.",
    onSuccess: onDone,
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate();
      }}
    >
      <CredentialFields draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
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

/** Replace an API key's secret. Resolves `true` once replaced, `false` if dismissed. */
export const ReplaceSecretModal = createModal<CredentialProps, boolean>(
  "replace-credential-secret",
  ({ credential, modal }) => (
    <ModalDialog modal={modal} dismissed={false} title={`Replace secret for ${credential.label}`}>
      <ReplaceSecretForm
        credential={credential}
        onDone={() => modal.resolve(true)}
        onCancel={() => modal.resolve(false)}
      />
    </ModalDialog>
  ),
);

function ReplaceSecretForm({
  credential,
  onDone,
  onCancel,
}: {
  credential: Credential;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [secret, setSecret] = useState("");
  const replace = useAction(() => api.updateCredential(credential.id, { secret }), {
    invalidate: [qk.providers],
    inline: true,
    success: "Secret replaced.",
    onSuccess: onDone,
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        replace.mutate();
      }}
    >
      <FormField
        label="New API key"
        hint="Replacing the secret also puts a dead credential back into rotation."
      >
        <Input
          type="password"
          required
          autoFocus
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </FormField>
      <FormError error={replace.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={replace.isPending}>
          {replace.isPending && <Spinner data-icon="inline-start" />}
          Replace secret
        </Button>
      </DialogFooter>
    </form>
  );
}
