import { t } from "@shared/i18n";
import { createTextSearch } from "../utils/search";
import { useState } from "react";
import {
  configuredCommands,
  shortcutLabel,
  type DesktopPlatform,
} from "../commands/shell-commands";
import { usePreferencesStore } from "../stores/preferences-store";
import { useAppStore } from "../stores/app-store";
import { Dialog, SearchField, Select, TextButton } from "../components/ui/index";

const LOCAL_SHORTCUTS = [
  {
    title: t("shortcutHelp.navigateCommandsOrRepositories"),
    keys: t("shortcutHelp.upDownEnter"),
    group: t("shortcutHelp.searchPicker"),
  },
  {
    title: t("shortcutHelp.openFirstMatchingSettingsSection"),
    keys: t("shortcutHelp.enter"),
    group: t("shortcutHelp.settingsSearch"),
  },
  {
    title: t("shortcutHelp.clearSettingsSearch"),
    keys: t("shortcutHelp.escape"),
    group: t("shortcutHelp.settingsSearch"),
  },
  {
    title: t("shortcutHelp.navigateRepositoryTabs"),
    keys: t("shortcutHelp.leftRightHomeEnd"),
    group: t("shortcutHelp.focusedTab"),
  },
  {
    title: t("shortcutHelp.reorderRepositoryTab"),
    keys: t("shortcutHelp.altShiftLeftRight"),
    group: t("shortcutHelp.focusedTab"),
  },
  {
    title: t("shortcutHelp.closeFocusedRepositoryTab"),
    keys: t("common.delete"),
    group: t("shortcutHelp.focusedTab"),
  },
  {
    title: t("shortcutHelp.selectColorTheme"),
    keys: t("shortcutHelp.arrowKeysHomeEnd"),
    group: t("shortcutHelp.themePicker"),
  },
  {
    title: t("shortcutHelp.resizePaneDivider"),
    keys: t("shortcutHelp.arrowKeys"),
    group: t("shortcutHelp.focusedDivider"),
  },
  {
    title: t("shortcutHelp.closeDialogOrMenu"),
    keys: t("shortcutHelp.escape"),
    group: t("shortcutHelp.dialogsAndMenus"),
  },
  {
    title: t("shortcutHelp.moveFocus"),
    keys: t("shortcutHelp.tabShiftTab"),
    group: t("shortcutHelp.dialogsAndControls"),
  },
];

export function ShortcutHelp({
  platform,
  onClose,
}: {
  platform: DesktopPlatform;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const overrides = usePreferencesStore((state) => state.values.shortcutOverrides.value);
  const owner = useAppStore((state) => state.activeIdentity?.id);
  const saving = usePreferencesStore((state) => state.saving);
  const [commandId, setCommandId] = useState("commands.open");
  const [error, setError] = useState("");
  const commands = configuredCommands(overrides);
  const save = async (chord: string | null) => {
    if (!owner || saving) return;
    const next = { ...overrides };
    if (chord === null) delete next[commandId];
    else {
      const used = commands.find(
        (item) =>
          item.id !== commandId &&
          item.shortcut &&
          (item.shortcut.shift ? "shift+" : "") + item.shortcut.key === chord,
      );
      if (used) {
        setError(t("shortcutHelp.conflict", { command: used.title }));
        return;
      }
      next[commandId] = chord;
    }
    setError("");
    await usePreferencesStore
      .getState()
      .set("shortcutOverrides", { kind: "profile", profileId: owner }, next);
  };
  const rows = [
    {
      title: t("shortcutHelp.submitCommit"),
      keys: shortcutLabel({ key: "Enter" }, platform),
      group: t("shortcutHelp.commitMessageRequiresAValidMessageAndStagedChanges"),
    },
    ...commands.flatMap((command) =>
      command.shortcut
        ? [
            {
              title: command.title,
              keys: shortcutLabel(command.shortcut, platform),
              group: command.group,
            },
          ]
        : [],
    ),
    ...LOCAL_SHORTCUTS,
  ];

  const matchesQuery = createTextSearch(query);
  const matches = rows.filter((row) => matchesQuery(`${row.title} ${row.keys} ${row.group}`));

  return (
    <Dialog
      title={t("shortcutHelp.keyboardShortcuts")}
      description={t("shortcutHelp.shortcutsFollowTheCurrentProfileAndRepositoryText")}
      onClose={onClose}
    >
      {owner && (
        <details className="mb-3">
          <summary>{t("shortcutHelp.customize")}</summary>
          <div className="my-2 flex flex-wrap items-center gap-2">
            <Select
              aria-label={t("shortcutHelp.command")}
              value={commandId}
              onValueChange={(value) => {
                setCommandId(value);
                setError("");
              }}
            >
              {commands.map((command) => (
                <option key={command.id} value={command.id}>
                  {command.title}
                </option>
              ))}
            </Select>
            <TextButton
              disabled={saving}
              onKeyDown={(event) => {
                if (event.key === "Tab" || event.key === "Escape") return;
                if (
                  (platform === "mac"
                    ? event.metaKey && !event.ctrlKey
                    : event.ctrlKey && !event.metaKey) &&
                  !event.altKey &&
                  /^[a-z0-9,/]$/i.test(event.key)
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  void save((event.shiftKey ? "shift+" : "") + event.key.toLowerCase());
                }
              }}
            >
              {t("shortcutHelp.record", {
                modifier: platform === "mac" ? t("shellCommands.cmd") : t("shellCommands.ctrl"),
              })}
            </TextButton>
            <TextButton disabled={saving} onClick={() => void save("")}>
              {t("shortcutHelp.unbind")}
            </TextButton>
            <TextButton disabled={saving} onClick={() => void save(null)}>
              {t("shortcutHelp.restore")}
            </TextButton>
          </div>
          {error && <p role="alert">{error}</p>}
        </details>
      )}
      <SearchField
        autoFocus
        size="md"
        aria-label={t("shortcutHelp.searchShortcuts")}
        placeholder={t("shortcutHelp.searchActionsOrKeys")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="mt-3 max-h-[min(20rem,40vh)] overflow-y-auto">
        {matches.map((row) => (
          <div
            key={row.title}
            className="flex items-center justify-between gap-4 border-b border-border-subtle py-3"
          >
            <div>
              <p className="text-sm">{row.title}</p>
              <p className="mt-1 text-xs text-text-tertiary">{row.group}</p>
            </div>
            <kbd className="max-w-44 text-right text-xs text-text-secondary">{row.keys}</kbd>
          </div>
        ))}
      </div>
      {matches.length === 0 && (
        <p role="status" className="py-4 text-sm text-text-tertiary">
          {t("shortcutHelp.noShortcutsMatch", { query: query })}
        </p>
      )}
    </Dialog>
  );
}
