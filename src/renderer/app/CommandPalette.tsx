import { t } from "@shared/i18n";
import { ErrorDialog } from "../components/ui/index";
import { useId, useRef, useState } from "react";
import { ArrowUpDownIcon as ArrowUpDown } from "../components/ui/icons";
import {
  configuredCommands,
  commandReason,
  sameCommandContext,
  searchCommands,
  shortcutLabel,
  type CommandContext,
  type DesktopPlatform,
  type ShellCommandId,
} from "../commands/shell-commands";
import { Dialog, SearchField, ListItemButton } from "../components/ui/index";
import { useListNavigation } from "../components/ui/hooks/useListNavigation";

import { usePreferencesStore } from "../stores/preferences-store";

export function CommandPalette({
  context,
  platform,
  onClose,
  onRun,
  onAfterClose,
}: {
  context: CommandContext;
  platform: DesktopPlatform;
  onClose: () => void;
  onAfterClose?: () => void;
  onRun: (id: ShellCommandId, expected: CommandContext) => void;
}) {
  const acceptedContext = useRef(context);
  const [query, setQuery] = useState("");
  const listId = useId();
  const commandRows = useRef(new Map<ShellCommandId, HTMLButtonElement>());
  const overrides = usePreferencesStore((state) => state.values.shortcutOverrides.value);
  const commands = searchCommands(query, configuredCommands(overrides)).filter(
    (command) => command.id !== "commands.open",
  );
  const { index, setHighlight, onKeyDown } = useListNavigation(
    commands.length,
    (position) => {
      const command = commands[position];
      if (command) run(command.id);
    },
    (position) => {
      const command = commands[position];
      if (command) commandRows.current.get(command.id)?.scrollIntoView({ block: "nearest" });
    },
  );

  const active = commands[index];
  const stale = !sameCommandContext(acceptedContext.current, context);
  const run = (id: ShellCommandId) => {
    const command = commands.find((item) => item.id === id);
    if (command && !stale && !commandReason(command, context)) onRun(id, acceptedContext.current);
  };

  return (
    <Dialog
      title={t("commandPalette.commandPalette")}
      description={t("commandPalette.searchActionsForTheCurrentProfileAndRepository")}
      onClose={onClose}
      onAfterClose={onAfterClose}
    >
      <SearchField
        autoFocus
        size="md"
        role="combobox"
        aria-label={t("commandPalette.searchCommands")}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={active ? `${listId}-${commands.indexOf(active)}` : undefined}
        placeholder={t("commandPalette.typeACommand")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
      />
      {stale && (
        <ErrorDialog>
          {t("commandPalette.theProfileOrRepositoryChangedReopenThePaletteToUseItsCommands")}
        </ErrorDialog>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={t("commandPalette.commands")}
        className="mt-3 max-h-[min(20rem,40vh)] overflow-y-auto"
      >
        {commands.map((command, position) => {
          const reason = stale
            ? t("commandPalette.contextChanged")
            : commandReason(command, context);

          return (
            <ListItemButton
              key={command.id}
              ref={(element) => {
                if (element) commandRows.current.set(command.id, element);
                else commandRows.current.delete(command.id);
              }}
              id={`${listId}-${position}`}
              role="option"
              selected={active?.id === command.id}
              tabIndex={-1}
              aria-selected={active?.id === command.id}
              aria-disabled={Boolean(reason)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setHighlight(position)}
              onClick={() => run(command.id)}
              className={reason ? "gap-3 px-3 py-2 text-text-tertiary" : "gap-3 px-3 py-2"}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{command.title}</span>
                <span className="mt-0.5 block text-xs text-text-tertiary">
                  {reason ?? command.group}
                </span>
              </span>
              {command.shortcut && (
                <kbd className="shrink-0 text-xs text-text-tertiary">
                  {shortcutLabel(command.shortcut, platform)}
                </kbd>
              )}
            </ListItemButton>
          );
        })}
      </div>
      {commands.length === 0 && (
        <p role="status" className="py-4 text-sm text-text-tertiary">
          {t("commandPalette.noCommandsMatch", { query: query })}
        </p>
      )}
      <p className="mt-3 flex items-center gap-1 border-t border-border-subtle pt-3 text-xs text-text-tertiary">
        <ArrowUpDown size={13} aria-hidden="true" />
        {t("commandPalette.navigateEnterRunEscapeClose")}
      </p>
    </Dialog>
  );
}
