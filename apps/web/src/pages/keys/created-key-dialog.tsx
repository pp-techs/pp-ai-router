import type { CreatedKey } from "../../api/types.ts";
import { Button } from "../../components/button.tsx";
import { CopyButton } from "../../components/copy-button.tsx";
import { Dialog, DialogActions } from "../../components/dialog.tsx";

/** The plaintext key exists only in this response; the server keeps just its hash. */
export function CreatedKeyDialog({
  created,
  onClose,
}: {
  created: CreatedKey;
  onClose: () => void;
}) {
  return (
    <Dialog title={`Key "${created.name}" created`} onClose={onClose} persistent>
      <p className="rounded-md bg-warn-soft px-3 py-2 text-warn">
        Copy this key now. It is shown only once and cannot be recovered later.
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-subtle p-3">
        <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{created.key}</code>
        <CopyButton text={created.key} />
      </div>
      <p className="text-muted">
        Use it as the API key of any OpenAI-compatible client with base URL{" "}
        <code className="font-mono text-xs">{window.location.origin}/v1</code>.
      </p>
      <DialogActions>
        <Button variant="primary" data-autofocus onClick={onClose}>
          I have copied the key
        </Button>
      </DialogActions>
    </Dialog>
  );
}
