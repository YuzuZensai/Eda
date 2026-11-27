import { ButtonBase } from "./ButtonBase";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../cx";

export function ProfileButton({
  children,
  className,
  type = "button",
  profileName,
  ...props
}: ComponentPropsWithRef<"button"> & { children: ReactNode; profileName?: string }) {
  return (
    <ButtonBase
      {...props}
      type={type}
      className={cx(
        "profile-button ui-press",
        "h-9 shrink-0 rounded-full p-1 text-text-tertiary",
        profileName ? "inline-flex items-center gap-2 pr-3" : "grid w-9 place-items-center",
        "hover:not-disabled:bg-bg-raised hover:not-disabled:text-text-primary",
        "disabled:cursor-progress disabled:opacity-50",
        className,
      )}
    >
      {children}
      {profileName && <span className="max-w-36 truncate text-sm font-medium">{profileName}</span>}
    </ButtonBase>
  );
}
