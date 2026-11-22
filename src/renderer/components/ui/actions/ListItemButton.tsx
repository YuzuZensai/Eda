import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../cx";
import { ButtonBase } from "./ButtonBase";

const ITEM_COLORS = {
  list: "text-text-secondary hover:not-disabled:bg-bg-raised hover:not-disabled:text-text-primary",
  menu: "text-text-secondary hover:not-disabled:bg-accent-muted hover:not-disabled:text-text-primary",
  danger: "text-git-deleted hover:not-disabled:bg-git-deleted/10 focus-visible:bg-git-deleted/10",
};

export function ListItemButton({
  children,
  selected = false,
  variant = "list",
  className,
  type = "button",
  ...props
}: ComponentPropsWithRef<"button"> & {
  children: ReactNode;
  selected?: boolean;
  variant?: keyof typeof ITEM_COLORS;
}) {
  return (
    <ButtonBase
      {...props}
      type={type}
      className={cx(
        "flex min-w-0 w-full items-center gap-2 rounded-sm px-2 text-left text-sm",
        variant === "list" ? "py-1.5" : "min-h-[32px] py-1",
        variant === "menu" && "focus-visible:bg-bg-raised",
        "disabled:cursor-not-allowed disabled:opacity-45",
        selected ? "bg-accent-muted text-accent-text" : ITEM_COLORS[variant],
        className,
      )}
    >
      {children}
    </ButtonBase>
  );
}

export function MenuItem({
  danger,
  ...props
}: ComponentPropsWithRef<"button"> & {
  children: ReactNode;
  danger?: boolean | undefined;
}) {
  return <ListItemButton {...props} role="menuitem" variant={danger ? "danger" : "menu"} />;
}
