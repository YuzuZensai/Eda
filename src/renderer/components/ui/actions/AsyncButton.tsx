import { t } from "@shared/i18n";
import { CopyIcon as Copy, RefreshIcon as RefreshCw } from "../icons";
import { useEffect, useRef, useState } from "react";
import { ACTION_FEEDBACK } from "../../../motion";
import { copyText } from "../../../utils/clipboard";
import { ActionIndicator, type ActionState } from "./ActionIndicator";
import { Button, type ButtonProps } from "./Button";

export function AsyncButton({
  label,
  onAction,
  icon = <RefreshCw size={16} aria-hidden="true" />,
  completed = false,
  children,
  onClick,
  ...props
}: Omit<ButtonProps, "busy" | "busyIndicator"> & {
  label: string;
  onAction: () => Promise<boolean>;
  completed?: boolean;
}) {
  const [state, setState] = useState<ActionState>("idle");
  const running = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!completed || running.current) return;
    clearTimeout(resetTimer.current);
    setState("success");
    resetTimer.current = setTimeout(() => setState("idle"), ACTION_FEEDBACK.outcomeHold);
  }, [completed]);

  const refresh = async () => {
    if (running.current) return;

    running.current = true;
    clearTimeout(resetTimer.current);
    setState("pending");

    const [success] = await Promise.all([
      Promise.resolve()
        .then(onAction)
        .catch(() => false),
      new Promise<void>((resolve) => setTimeout(resolve, ACTION_FEEDBACK.minimumPending)),
    ]);

    running.current = false;

    if (!mounted.current) return;

    setState(success ? "success" : "error");
    resetTimer.current = setTimeout(() => setState("idle"), ACTION_FEEDBACK.outcomeHold);
  };

  return (
    <>
      <Button
        {...props}
        aria-label={label}
        busy={state === "pending"}
        busyIndicator={false}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) void refresh();
        }}
        icon={<ActionIndicator state={state} idleIcon={icon} />}
      >
        {children}
      </Button>

      <span role="status" className="sr-only">
        {state === "success"
          ? t("asyncButton.completed", { label: label })
          : state === "error"
            ? t("asyncButton.failedTryAgain", { label: label })
            : ""}
      </span>
    </>
  );
}

export function CopyButton({
  value,
  copied = false,
  label = t("common.copy"),
  size = "icon-sm",
}: {
  value: string;
  copied?: boolean;
  label?: string;
  size?: "icon-sm" | "icon-xs";
}) {
  const copy = async () => {
    await copyText(value);
    return true;
  };

  return (
    <AsyncButton
      key={value}
      size={size}
      variant="ghost"
      label={label}
      title={label}
      completed={copied}
      onAction={copy}
      icon={<Copy size={14} aria-hidden="true" />}
    />
  );
}

export function RefreshButton({
  label = t("common.refresh"),
  onRefresh,
  disabled = false,
}: {
  label?: string;
  onRefresh: () => Promise<boolean>;
  disabled?: boolean;
}) {
  return (
    <AsyncButton
      label={label}
      title={label}
      onAction={onRefresh}
      disabled={disabled}
      size="icon-sm"
      variant="ghost"
    />
  );
}
