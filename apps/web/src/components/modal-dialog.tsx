import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** The slice of the `modal` object better-modal injects that the dialog chrome needs. */
export interface ModalHandle<TResult> {
  visible: boolean;
  resolve: (value: TResult) => void;
  remove: () => void;
}

/**
 * Shared chrome for better-modal dialogs. Closing by Escape, backdrop or the X resolves with
 * `dismissed`; the store entry is removed once the exit animation ends, so props (a one-time key,
 * say) never linger in memory and the next open starts from fresh state.
 * Put form state in children: they unmount with the popup.
 */
export function ModalDialog<TResult>({
  modal,
  dismissed,
  title,
  description,
  wide = false,
  persistent = false,
  children,
}: {
  modal: ModalHandle<TResult>;
  /** What `show()` resolves with when the user dismisses without completing. */
  dismissed: TResult;
  title: ReactNode;
  description?: ReactNode;
  wide?: boolean;
  /** Only an explicit button closes it: no Escape, backdrop click or X (for one-time secrets). */
  persistent?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={modal.visible}
      disablePointerDismissal={persistent}
      onOpenChange={(open, details) => {
        if (open) return;
        if (persistent) details.cancel();
        else modal.resolve(dismissed);
      }}
      onOpenChangeComplete={(open) => {
        if (!open) modal.remove();
      }}
    >
      <DialogContent
        showCloseButton={!persistent}
        className={cn("max-h-[90vh] overflow-y-auto", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
