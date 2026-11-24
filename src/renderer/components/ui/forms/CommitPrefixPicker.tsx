import { t } from "@shared/i18n";
import { useId, useRef, useState } from "react";
import { CheckIcon as Check, ChevronDownIcon as ChevronDown } from "../icons";
import { Button } from "../actions/Button";
import { ListItemButton } from "../actions/ListItemButton";
import { SearchField } from "./SearchField";
import { AnchoredPopover } from "../overlays/PopoverSurface";

export function CommitPrefixPicker({
  value,
  prefixes,
  disabled,
  onChange,
}: {
  value: string;
  prefixes: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const optionButtons = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const options = [
    ...prefixes.filter((prefix) =>
      prefix.toLowerCase().includes(query.toLowerCase().replace(/:\s*$/, "")),
    ),
    "",
  ];

  return (
    <>
      <span className="max-w-[45%] shrink-0">
        <Button
          ref={trigger}
          size="sm"
          className="h-8 max-w-full"
          aria-label={t("commitPrefixPicker.commitPrefix")}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          disabled={disabled}
          onClick={() => {
            if (open) close();
            else {
              setQuery("");
              setOpen(true);
            }
          }}
        >
          {value ? `${value}:` : t("commitPrefixPicker.noPrefix")}
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </span>

      {open && !disabled && (
        <AnchoredPopover
          anchorRef={trigger}
          placement="top-start"
          returnFocusRef={trigger}
          id={id}
          role="dialog"
          aria-label={t("commitPrefixPicker.chooseCommitPrefix")}
          onClose={close}
          className="w-56 p-1"
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

            event.preventDefault();

            const fields = [
              search.current,
              ...options.map((prefix) => optionButtons.current.get(prefix)),
            ].filter((element): element is HTMLInputElement | HTMLButtonElement => !!element);

            const index = fields.findIndex((element) => element === event.target);

            fields[
              (index + (event.key === "ArrowDown" ? 1 : -1) + fields.length) % fields.length
            ]?.focus();
          }}
        >
          <SearchField
            ref={search}
            autoFocus
            aria-label={t("commitPrefixPicker.searchCommitPrefixes")}
            placeholder={t("commitPrefixPicker.searchPrefixes")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onChange(options[0]!);
                close();
              }
            }}
          />

          <div className="mt-1 max-h-56 overflow-y-auto">
            {options.map((prefix) => (
              <ListItemButton
                key={prefix}
                ref={(element) => {
                  if (element) optionButtons.current.set(prefix, element);
                  else optionButtons.current.delete(prefix);
                }}
                variant="menu"
                selected={value === prefix}
                data-eda-select-value={prefix}
                aria-pressed={value === prefix}
                className="justify-between"
                onClick={() => {
                  onChange(prefix);
                  close();
                }}
              >
                {prefix ? `${prefix}:` : t("commitPrefixPicker.noPrefix")}
                {value === prefix && <Check size={14} aria-hidden="true" />}
              </ListItemButton>
            ))}
          </div>
        </AnchoredPopover>
      )}
    </>
  );
}
