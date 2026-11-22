import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "../icons";
import { AnchoredPopover } from "../overlays/PopoverSurface";
import { MenuItem } from "./ListItemButton";

export function MenuSubmenu({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const triggerId = useId();
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<"hover" | "focus" | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const closeAfterPointerLeave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      setOpen((current) => (current === "hover" ? null : current));
    }, 150);
  };

  return (
    <>
      <MenuItem
        id={triggerId}
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open ? menuId : undefined}
        className="aria-expanded:bg-accent-muted aria-expanded:text-text-primary"
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          clearTimeout(leaveTimer.current);
          setOpen((current) => current ?? "hover");
        }}
        onPointerLeave={closeAfterPointerLeave}
        onClick={() => setOpen((current) => (current === "focus" ? null : "focus"))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          setOpen("focus");
        }}
      >
        {icon}
        {label}
        <ChevronRightIcon size={13} className="ml-auto shrink-0" aria-hidden="true" />
      </MenuItem>

      {open && (
        <AnchoredPopover
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          anchorRef={trigger}
          placement="right-start"
          autoFocus={open === "focus"}
          onClose={() => setOpen(null)}
          onPointerEnter={() => clearTimeout(leaveTimer.current)}
          onPointerLeave={closeAfterPointerLeave}
          className="w-44 p-1"
        >
          {children}
        </AnchoredPopover>
      )}
    </>
  );
}
