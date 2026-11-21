import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cx } from "../cx";
import { useOverlayPresence } from "./overlay-presence";

export const ModalBehaviorContext = createContext(true);
export const ModalSurfaceContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function ModalSurface({
  onClose,
  onAfterClose,
  placement = "center",
  className,
  descriptionId,
  dismissible = true,
  children,
}: {
  onClose: () => void;
  onAfterClose?: (() => void) | undefined;
  placement?: "center" | "right" | "top";
  className?: string;
  descriptionId?: string | undefined;
  dismissible?: boolean;
  children: ReactNode;
}) {
  const modal = useContext(ModalBehaviorContext);
  const surface = useRef<HTMLDivElement>(null);
  useOverlayPresence();

  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  const close = () => {
    if (!dismissible) return;

    onClose();
  };

  return (
    <DialogPrimitive.Root modal={modal} open onOpenChange={(open) => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-overlay-in fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />

        <DialogPrimitive.Content
          ref={surface}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
            onAfterClose?.();
          }}
          onInteractOutside={(event) => {
            if (!modal || !dismissible) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          aria-modal={modal}
          aria-describedby={descriptionId}
          data-placement={placement}
          className={cx(
            "ui-surface-in fixed z-50 bg-bg-overlay shadow-popover",
            placement === "right"
              ? "bottom-0 right-0 top-[var(--toolbar-height)]"
              : placement === "top"
                ? "left-1/2 top-[12vh] -translate-x-1/2"
                : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
            className,
          )}
        >
          <ModalSurfaceContext value={surface}>{children}</ModalSurfaceContext>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const ModalTitle = DialogPrimitive.Title;
export const ModalDescription = DialogPrimitive.Description;
