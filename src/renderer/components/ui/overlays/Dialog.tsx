import { t } from "@shared/i18n";
import { useId, type ReactNode } from "react";
import { ModalDescription, ModalSurface, ModalTitle } from "./ModalSurface";
import { IconButton } from "../actions/Button";
import { CloseIcon } from "../icons";
import { AnimatedSize } from "../display/AnimatedSize";

export interface DialogProps {
  title: string;
  description?: string;
  onClose: () => void;
  onAfterClose?: (() => void) | undefined;
  busy?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  placement?: "center" | "right";
  wide?: boolean;
  size?: "md" | "lg" | "xl";
}

export function Dialog({
  title,
  description,
  onClose,
  onAfterClose,
  busy = false,
  footer,
  children,
  placement = "center",
  wide = false,
  size = "md",
}: DialogProps) {
  const descriptionId = useId();
  const placementWidth = placement === "right" ? "w-full" : "w-[calc(100vw-2rem)]";

  const maxWidth = wide
    ? "max-w-[76rem]"
    : size === "xl"
      ? "max-w-[60rem]"
      : size === "lg"
        ? "max-w-[40rem]"
        : "max-w-[30rem]";

  const height = placement === "right" ? "min-h-0" : "max-h-[90vh] rounded-lg";

  return (
    <ModalSurface
      onClose={onClose}
      onAfterClose={onAfterClose}
      dismissible={!busy}
      placement={placement}
      descriptionId={description ? descriptionId : undefined}
      className={`${placementWidth} ${maxWidth} flex flex-col overflow-hidden border border-border-default ${height}`}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-4">
        <ModalTitle className="min-w-0 text-xl font-semibold tracking-tight">{title}</ModalTitle>

        <IconButton
          aria-label={t("dialog.closeDialog")}
          title={t("dialog.closeEsc")}
          className="-mr-1 -mt-1"
          icon={<CloseIcon size={16} />}
          onClick={onClose}
          disabled={busy}
        />
      </div>

      {description && (
        <ModalDescription
          id={descriptionId}
          className="mt-1 shrink-0 px-5 text-sm leading-normal text-text-secondary"
        >
          {description}
        </ModalDescription>
      )}

      <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4">
        <AnimatedSize>{children}</AnimatedSize>
      </div>

      {footer && (
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border-subtle px-5 py-3">
          {footer}
        </div>
      )}
    </ModalSurface>
  );
}
