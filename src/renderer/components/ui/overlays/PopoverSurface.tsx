import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type Placement,
} from "@floating-ui/react-dom";
import {
  useContext,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ModalSurfaceContext } from "./ModalSurface";
import { useDismiss } from "../hooks/useDismiss";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";
import { cx } from "../cx";
import { useOverlayPresence } from "./overlay-presence";

export const POPOVER_SURFACE_STYLE =
  "rounded-lg border border-border-default bg-bg-overlay text-text-primary shadow-popover";

export interface PopoverSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  role: "menu" | "dialog";
  onClose: () => void;
  interactionRef?: RefObject<HTMLElement | null>;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null>;
  autoFocus?: boolean;
  children: ReactNode;
}

export function PopoverSurface({
  role,
  onClose,
  interactionRef,
  surfaceRef,
  returnFocusRef,
  triggerRef,
  autoFocus,
  className,
  children,
  ...props
}: PopoverSurfaceProps) {
  const fallbackRoot = useRef<HTMLDivElement>(null);
  const root = surfaceRef ?? fallbackRoot;
  const scope = interactionRef ?? root;

  useOverlayPresence();
  useMenuKeyboard(scope, role === "menu", onClose, returnFocusRef, triggerRef, autoFocus);
  useDismiss(scope, role === "dialog", onClose, returnFocusRef, triggerRef);

  return (
    <div
      {...props}
      ref={root}
      role={role}
      className={cx("ui-popover-in z-50 overflow-hidden", POPOVER_SURFACE_STYLE, className)}
    >
      {children}
    </div>
  );
}

export function AnchoredPopover({
  anchorRef,
  placement = "bottom-start",
  gap = 4,
  className,
  style,
  returnFocusRef = anchorRef,
  ...props
}: Omit<PopoverSurfaceProps, "surfaceRef" | "triggerRef"> & {
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  gap?: number;
}) {
  const modal = useContext(ModalSurfaceContext);
  const surface = useRef<HTMLDivElement>(null);

  const { refs, floatingStyles } = useFloating({
    placement,
    strategy: "fixed",
    transform: false,
    middleware: [offset(gap), flip({ padding: 8 }), shift({ padding: 8, crossAxis: true })],
    whileElementsMounted: autoUpdate,
  });

  useLayoutEffect(() => {
    refs.setReference(anchorRef.current);
    refs.setFloating(surface.current);
  }, [anchorRef, refs.setReference, refs.setFloating]);

  return createPortal(
    <PopoverSurface
      {...props}
      surfaceRef={surface}
      returnFocusRef={returnFocusRef}
      triggerRef={anchorRef}
      className={cx(
        "max-h-[calc(100dvh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto",
        className,
      )}
      style={{ ...style, ...floatingStyles }}
    />,
    modal?.current ?? document.body,
  );
}
