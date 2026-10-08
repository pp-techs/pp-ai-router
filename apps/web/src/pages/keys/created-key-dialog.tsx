import { createModal } from "@buiducnhat/better-modal";
import { TriangleAlertIcon } from "lucide-react";
import type { CreatedKey } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { ModalDialog } from "@/components/modal-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";

type Props = { created: CreatedKey };

/** The plaintext key exists only in this response; the server keeps just its hash. */
export const CreatedKeyModal = createModal<Props, void>("created-key", ({ created, modal }) => (
  <ModalDialog
    modal={modal}
    dismissed={undefined}
    title={`Key "${created.name}" created`}
    persistent
  >
    <Alert>
      <TriangleAlertIcon />
      <AlertDescription>
        Copy this key now. It is shown only once and cannot be recovered later.
      </AlertDescription>
    </Alert>
    <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
      <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{created.key}</code>
      <CopyButton text={created.key} />
    </div>
    <p className="text-muted-foreground">
      Use it as the API key of any OpenAI-compatible client with base URL{" "}
      <code className="font-mono text-xs">{window.location.origin}/v1</code>.
    </p>
    <DialogFooter>
      <Button autoFocus onClick={() => modal.resolve(undefined)}>
        I have copied the key
      </Button>
    </DialogFooter>
  </ModalDialog>
));
