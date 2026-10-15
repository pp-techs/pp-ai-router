import { createModal } from "@buiducnhat/better-modal";
import { useState, type ReactNode } from "react";
import { FormError } from "@/components/form-error";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

type Props = {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /** Red confirm button (the default); false for a plain confirmation. */
  destructive?: boolean;
  /** Runs on confirm. The dialog stays open with a spinner meanwhile, and shows the error if it throws. */
  action: () => Promise<unknown>;
};

/** Confirmation, destructive (red) unless told otherwise. `show()` resolves `true` once `action` succeeded, `false` if dismissed. */
export const ConfirmModal = createModal<Props, boolean>(
  "confirm",
  ({ title, message, confirmLabel, destructive = true, action, modal }) => (
    <ModalDialog modal={modal} dismissed={false} title={title}>
      <ConfirmBody
        message={message}
        confirmLabel={confirmLabel}
        destructive={destructive}
        action={action}
        onDone={() => modal.resolve(true)}
        onCancel={() => modal.resolve(false)}
      />
    </ModalDialog>
  ),
);

function ConfirmBody({
  message,
  confirmLabel,
  destructive,
  action,
  onDone,
  onCancel,
}: Pick<Props, "message" | "confirmLabel" | "action"> & {
  destructive: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (e) {
      setError(e as Error);
      setPending(false);
    }
  }

  return (
    <>
      <div className="text-muted-foreground">{message}</div>
      <FormError error={error} />
      <DialogFooter>
        <Button variant="outline" autoFocus onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          disabled={pending}
          onClick={() => void confirm()}
        >
          {pending && <Spinner data-icon="inline-start" />}
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
