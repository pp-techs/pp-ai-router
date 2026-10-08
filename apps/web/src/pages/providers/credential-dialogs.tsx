import { useState } from "react";
import { api } from "../../api/client.ts";
import { qk, useAction } from "../../api/queries.ts";
import type { Credential } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { Dialog, DialogActions } from "../../components/dialog.tsx";
import { Field, FormError, Input } from "../../components/fields.tsx";
import {
  draftFromCredential,
  draftToBody,
  emptyCredentialDraft,
  type CredentialDraft,
} from "../../lib/credential-draft.ts";
import { CredentialFields } from "./credential-fields.tsx";

export function AddCredentialDialog({
  providerId,
  onClose,
}: {
  providerId: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CredentialDraft>(emptyCredentialDraft);
  const [secret, setSecret] = useState("");
  const create = useAction(
    () => api.createCredential(providerId, { ...draftToBody(draft), secret }),
    {
      invalidate: [qk.providers],
      inline: true,
      success: "Credential added.",
      onSuccess: onClose,
    },
  );

  return (
    <Dialog title="Add API key" onClose={onClose}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field
          label="API key"
          hint="Stored encrypted; only the last 4 characters are shown afterwards."
        >
          <Input
            type="password"
            required
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <CredentialFields
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        />
        <FormError error={create.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Add credential
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function EditCredentialDialog({
  credential,
  onClose,
}: {
  credential: Credential;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFromCredential(credential));
  const update = useAction(() => api.updateCredential(credential.id, draftToBody(draft)), {
    invalidate: [qk.providers],
    inline: true,
    success: "Credential updated.",
    onSuccess: onClose,
  });

  return (
    <Dialog title={`Edit ${credential.label}`} onClose={onClose}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate();
        }}
      >
        <CredentialFields
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
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

export function ReplaceSecretDialog({
  credential,
  onClose,
}: {
  credential: Credential;
  onClose: () => void;
}) {
  const [secret, setSecret] = useState("");
  const replace = useAction(() => api.updateCredential(credential.id, { secret }), {
    invalidate: [qk.providers],
    inline: true,
    success: "Secret replaced.",
    onSuccess: onClose,
  });

  return (
    <Dialog title={`Replace secret for ${credential.label}`} onClose={onClose}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          replace.mutate();
        }}
      >
        <Field
          label="New API key"
          hint="Replacing the secret also puts a dead credential back into rotation."
        >
          <Input
            type="password"
            required
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <FormError error={replace.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={replace.isPending}>
            Replace secret
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
