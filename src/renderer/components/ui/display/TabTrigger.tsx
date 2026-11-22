import { ButtonBase } from "../actions/ButtonBase";
import type { ComponentPropsWithRef, KeyboardEvent, ReactNode } from "react";
import { cx } from "../cx";

export function TabTrigger({
  selected,
  indicator = true,
  children,
  className,
  type = "button",
  ...props
}: ComponentPropsWithRef<"button"> & {
  selected: boolean;
  indicator?: boolean;
  children: ReactNode;
}) {
  return (
    <ButtonBase
      {...props}
      type={type}
      role="tab"
      aria-selected={selected}
      className={cx(
        "ui-tab relative flex min-w-0 items-center gap-2 rounded-sm border-b-2 border-transparent px-2 py-1.5 text-left text-xs font-medium",
        "hover:not-disabled:bg-bg-raised",
        selected ? "text-text-primary" : "text-text-secondary",
        className,
      )}
    >
      {indicator && <span aria-hidden="true" className="ui-tab-indicator" />}
      {children}
    </ButtonBase>
  );
}

export function navigateTabList(event: KeyboardEvent<HTMLDivElement>) {
  const vertical = event.currentTarget.getAttribute("aria-orientation") === "vertical";
  const previous = vertical ? "ArrowUp" : "ArrowLeft";
  const following = vertical ? "ArrowDown" : "ArrowRight";
  if (![previous, following, "Home", "End"].includes(event.key)) return;

  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]:enabled'),
  );
  const index = tabs.findIndex((tab) => tab === event.target);
  if (index < 0) return;

  event.preventDefault();
  const step = event.key === previous ? -1 : 1;
  let next = tabs[(index + step + tabs.length) % tabs.length];
  if (event.key === "Home") next = tabs[0];
  if (event.key === "End") next = tabs.at(-1);
  if (next) {
    next.click();
    next.focus();
  }
}
