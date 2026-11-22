import { EllipsisIcon as Ellipsis } from "../icons";
import { useId, useRef, useState, type ReactNode } from "react";
import { IconButton } from "./Button";
import { MenuItem } from "./ListItemButton";
import { AnchoredPopover } from "../overlays/PopoverSurface";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect(): void;
  danger?: boolean;
}

export function ActionsMenu({
  label,
  disabled = false,
  items,
}: {
  label: string;
  disabled?: boolean;
  items: readonly MenuAction[];
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <IconButton
        ref={trigger}
        icon={<Ellipsis size={16} />}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      />

      {open && (
        <AnchoredPopover
          id={id}
          role="menu"
          aria-label={label}
          anchorRef={trigger}
          placement="bottom-end"
          returnFocusRef={trigger}
          onClose={() => setOpen(false)}
          className="w-52 p-1"
        >
          {items.map((item) => (
            <MenuItem
              key={item.label}
              danger={item.danger}
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </MenuItem>
          ))}
        </AnchoredPopover>
      )}
    </>
  );
}
