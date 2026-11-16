import { ButtonBase } from "./ButtonBase";
import { useEffect, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { ActionIndicator, type ActionOutcome } from "./ActionIndicator";
import { accentComponents, type AccentColor } from "@shared/preferences/accent";
import { cx } from "../cx";
import { ACTION_FEEDBACK } from "../../../motion";

export type ButtonVariant = "primary" | "identity" | "secondary" | "ghost" | "quiet" | "danger";

export type ButtonSize = "sm" | "md" | "lg" | "icon" | "icon-sm" | "icon-xs";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-text-primary text-text-inverse hover:not-disabled:opacity-85",
  identity: cx(
    "border-transparent bg-[oklch(var(--accent-l)_var(--identity-chroma)_var(--identity-hue))] text-text-inverse",
    "hover:not-disabled:bg-[oklch(var(--accent-hover-l)_var(--identity-chroma)_var(--identity-hue))]",
  ),
  secondary: cx(
    "bg-bg-raised text-text-primary border-border-default",
    "hover:not-disabled:bg-bg-raised hover:not-disabled:border-border-strong",
  ),
  ghost:
    "border-transparent text-text-secondary hover:not-disabled:bg-bg-raised hover:not-disabled:text-text-primary",
  quiet: "border-transparent text-text-tertiary hover:not-disabled:text-text-primary",
  danger: cx(
    "text-git-deleted border-git-deleted",
    "hover:not-disabled:bg-git-deleted/10 hover:not-disabled:border-git-deleted",
  ),
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-7 gap-1.5 rounded-sm px-2.5 py-1 text-xs",
  md: "min-h-9 gap-2 rounded-md px-3 py-2 text-sm",
  lg: "gap-2 rounded-md px-5 py-3 text-base font-[550]",
  icon: "size-9 rounded-md",
  "icon-sm": "size-[32px] rounded-md",
  "icon-xs": "size-[24px] rounded-sm",
};

export interface ButtonProps extends Omit<ComponentPropsWithRef<"button">, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  iconPosition?: "start" | "end";
  busy?: boolean;
  busyIndicator?: boolean;
  feedback?: ActionOutcome;
  hue?: AccentColor | undefined;
  className?: string | undefined;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  block = false,
  icon,
  iconPosition = "start",
  busy = false,
  busyIndicator = true,
  feedback,
  hue,
  disabled,
  type = "button",
  children,
  className,
  style,
  ...rest
}: ButtonProps) {
  const [showSpinner, setShowSpinner] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome>("idle");

  useEffect(() => {
    setOutcome(busy ? "idle" : (feedback ?? "idle"));
    if (busy || !feedback || feedback === "idle") return;
    const timer = window.setTimeout(() => setOutcome("idle"), ACTION_FEEDBACK.outcomeHold);
    return () => window.clearTimeout(timer);
  }, [busy, feedback]);

  useEffect(() => {
    if (!busy) {
      setShowSpinner(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSpinner(true), ACTION_FEEDBACK.spinnerDelay);
    return () => window.clearTimeout(timer);
  }, [busy]);

  const spinning = feedback === undefined && busy && busyIndicator && showSpinner;
  const displayedIcon =
    feedback === undefined ? (
      icon
    ) : (
      <ActionIndicator state={busy ? "pending" : outcome} idleIcon={icon} />
    );
  const accent = hue === undefined ? null : accentComponents(hue);
  const iconSlot = displayedIcon ? (
    <span className="relative inline-flex shrink-0 items-center justify-center">
      <span className={cx("inline-flex", spinning && "opacity-0")}>{displayedIcon}</span>
      {spinning && (
        <span className="absolute inset-0 flex items-center justify-center">
          <ActionIndicator state="pending" />
        </span>
      )}
    </span>
  ) : null;

  return (
    <ButtonBase
      {...rest}
      type={type}
      aria-busy={busy || undefined}
      data-variant={variant}
      disabled={disabled || busy}
      style={{
        ...(accent
          ? ({
              "--identity-hue": accent.hue,
              "--identity-chroma": accent.chroma,
            } as React.CSSProperties)
          : null),
        ...style,
      }}
      className={cx(
        "ui-button ui-press relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap",
        "border font-medium tracking-tight",
        "disabled:cursor-not-allowed disabled:opacity-45",
        busy && "cursor-progress opacity-100 disabled:opacity-100",
        VARIANTS[variant],
        SIZES[size],
        block && "flex w-full",
        className,
      )}
    >
      {iconPosition === "start" && iconSlot}
      {children != null && (
        <span
          className={cx(
            "inline-flex items-center justify-center gap-[inherit]",
            spinning && !icon && "opacity-0",
          )}
        >
          {children}
        </span>
      )}
      {iconPosition === "end" && iconSlot}
      {spinning && !icon && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <ActionIndicator state="pending" />
        </span>
      )}
    </ButtonBase>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "icon" | "children" | "size"> {
  "aria-label": string;
  icon: ReactNode;
  size?: "xs" | "sm" | "md";
}

export function IconButton({ icon, size = "sm", variant = "ghost", ...props }: IconButtonProps) {
  return (
    <Button
      {...props}
      icon={icon}
      size={size === "md" ? "icon" : `icon-${size}`}
      variant={variant}
    />
  );
}
