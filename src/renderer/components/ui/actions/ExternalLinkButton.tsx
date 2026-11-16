import { useEffect, useState } from "react";
import { t } from "@shared/i18n";
import { copyText } from "../../../utils/clipboard";
import { CopyIcon as Copy, ExternalLinkIcon as ExternalLink } from "../icons";
import { AsyncButton } from "./AsyncButton";
import type { ButtonProps } from "./Button";

export type ExternalLinkTarget =
  | { href: string; onOpen?: never; onCopy?: never }
  | { href?: never; onOpen: () => void; onCopy: () => Promise<boolean> };

export function ExternalLinkButton({
  href,
  onOpen,
  onCopy,
  variant = "ghost",
  size = "sm",
  icon,
  trailingIcon = false,
  onClick,
  onKeyDown,
  children,
  title,
  "aria-label": ariaLabel,
  ...props
}: Omit<ButtonProps, "busy" | "busyIndicator"> & ExternalLinkTarget & { trailingIcon?: boolean }) {
  const [copyMode, setCopyMode] = useState(false);
  const mac = window.eda?.app?.platform === "mac";
  const isCopy = (event: { metaKey: boolean; ctrlKey: boolean }) =>
    mac ? event.metaKey : event.ctrlKey;
  const copyLabel = t("common.copyUrl");
  const label = ariaLabel ?? (typeof children === "string" ? children : t("common.openInBrowser"));
  const openIcon = trailingIcon ? (
    <ExternalLink size={13} aria-hidden="true" />
  ) : (
    (icon ?? <ExternalLink size={13} aria-hidden="true" />)
  );

  useEffect(() => {
    const update = (event: KeyboardEvent | PointerEvent) =>
      setCopyMode(mac ? event.metaKey : event.ctrlKey);
    const reset = () => setCopyMode(false);
    const visibility = () => {
      if (document.hidden) reset();
    };

    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("pointermove", update);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", visibility);

    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("pointermove", update);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [mac]);

  return (
    <AsyncButton
      {...props}
      variant={variant}
      size={size}
      label={copyMode ? copyLabel : label}
      title={
        copyMode
          ? copyLabel
          : (title ??
            t("externalLinkButton.copyHint", {
              modifier: mac ? t("shellCommands.cmd") : t("shellCommands.ctrl"),
            }))
      }
      iconPosition={trailingIcon ? "end" : "start"}
      icon={copyMode ? <Copy size={13} aria-hidden="true" /> : openIcon}
      onAction={async () => {
        if (onCopy) return onCopy();
        await copyText(href);
        return true;
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;

        if (!isCopy(event)) {
          event.preventDefault();
          if (onOpen) onOpen();
          else window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !isCopy(event) || !["Enter", " "].includes(event.key)) return;

        event.preventDefault();
        if (event.repeat) return;

        // Cmd+Enter doesn't trigger a click on macOS, so send one with the modifier keys intact.
        event.currentTarget.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
          }),
        );
      }}
    >
      {trailingIcon && icon}
      {children}
    </AsyncButton>
  );
}
