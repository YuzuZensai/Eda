import { t } from "@shared/i18n";
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  type ComponentPropsWithRef,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon as Check, ChevronDownIcon as ChevronDown } from "../icons";
import { cx } from "../cx";
import { controlAppearance, controlSize, type ControlSurface } from "./controlStyles";

import { POPOVER_SURFACE_STYLE } from "../overlays/PopoverSurface";

const EMPTY_OPTION = "__eda_empty_option__";

interface Choice {
  value: string;
  label: ReactNode;
  disabled: boolean;
}

function choicesFrom(children: ReactNode): Choice[] {
  return Children.toArray(children).flatMap((child): Choice[] => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment)
      return choicesFrom((child.props as { children?: ReactNode }).children);
    if (child.type !== "option") return [];

    const props = child.props as {
      value?: string | number;
      disabled?: boolean;
      children?: ReactNode;
    };

    return [
      {
        value: String(props.value ?? props.children ?? ""),
        label: props.children,
        disabled: !!props.disabled,
      },
    ];
  });
}

export interface SelectProps {
  id?: string;
  name?: string;
  title?: string;
  "aria-label"?: string;
  "aria-describedby"?: string | undefined;
  value: string | number;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  className?: string;
  surface?: ControlSurface;
  compact?: boolean;
  children: ReactNode;
}

export function Select({
  id,
  name,
  title,
  value,
  onValueChange,
  disabled,
  required,
  invalid = false,
  className,
  surface = "inset",
  compact = false,
  children,
  ...aria
}: SelectProps) {
  const choices = choicesFrom(children);
  const empty = choices.find((choice) => choice.value === "");
  let emptyOptionValue = EMPTY_OPTION;

  while (choices.some((choice) => choice.value === emptyOptionValue)) emptyOptionValue += "_";

  const current = String(value);
  const selected = current === "" && empty && !empty.disabled ? emptyOptionValue : current;

  return (
    <SelectPrimitive.Root
      value={selected}
      onValueChange={(next) => onValueChange(next === emptyOptionValue ? "" : next)}
      disabled={disabled}
      required={required}
      name={name}
    >
      <SelectPrimitive.Trigger
        id={id}
        title={title}
        {...aria}
        aria-invalid={invalid || undefined}
        className={cx(
          controlAppearance(surface, invalid),
          controlSize(compact ? "sm" : "md"),
          "ui-select-trigger inline-flex max-w-full items-center justify-between gap-2 text-left",
          "data-[state=open]:border-accent",
          className,
        )}
      >
        <SelectPrimitive.Value
          className="block min-w-0 flex-1 truncate"
          placeholder={empty?.label ?? t("formControls.selectAnOption")}
        />

        <SelectPrimitive.Icon className="ui-select-chevron shrink-0 text-text-tertiary">
          <ChevronDown size={14} aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          data-eda-select-popover=""
          className={cx(
            POPOVER_SURFACE_STYLE,
            "ui-popover-in z-[100] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-1rem)] overflow-hidden",
          )}
        >
          <SelectPrimitive.Viewport className="max-h-72 overflow-y-auto p-1">
            {choices.map((choice, index) => (
              <SelectPrimitive.Item
                key={`${choice.value}-${index}`}
                value={choice.value === "" ? emptyOptionValue : choice.value}
                disabled={choice.disabled}
                data-eda-select-value={choice.value}
                className="ui-select-option relative flex min-h-[32px] w-full cursor-default items-center rounded-sm px-2 pr-8 text-sm text-text-primary outline-none data-[highlighted]:bg-accent-muted data-[state=checked]:font-medium data-[disabled]:opacity-45"
              >
                <SelectPrimitive.ItemText>{choice.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 text-accent-text">
                  <Check size={14} aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export interface TextareaProps extends ComponentPropsWithRef<"textarea"> {
  surface?: ControlSurface;
  invalid?: boolean;
}

export function Textarea({
  surface = "inset",
  invalid = false,
  className,
  ...props
}: TextareaProps) {
  return (
    <textarea
      {...props}
      aria-invalid={invalid || props["aria-invalid"]}
      className={cx(
        controlAppearance(surface, invalid),
        "w-full resize-y px-3 py-2 text-sm placeholder:text-text-tertiary",
        className,
      )}
    />
  );
}
