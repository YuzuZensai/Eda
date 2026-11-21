import { t } from "@shared/i18n";
import type { ReactNode } from "react";
import { IdentitySwitcher } from "../features/profiles/IdentitySwitcher";
import { Button, SettingsIcon, cx } from "../components/ui/index";
import { ArrowLeftIcon as ArrowLeft, SearchIcon as Search } from "../components/ui/icons";
import { usePreferencesStore } from "../stores/preferences-store";
import {
  configuredCommands,
  shortcutLabel,
  type DesktopPlatform,
} from "../commands/shell-commands";
import { WindowTitlebar } from "./WindowControls";

export function Toolbar({
  onAddIdentity,
  onManageProfiles,
  onOpenSettings,
  onOpenCommands,
  platform,
  settingsOpen,
  tabs,
}: {
  onAddIdentity: () => void;
  onManageProfiles: () => void;
  onOpenSettings: () => void;
  onOpenCommands: () => void;
  platform: DesktopPlatform;
  settingsOpen: boolean;
  tabs?: ReactNode;
}) {
  const labels = usePreferencesStore((state) => state.values.toolbarLabels.value);
  const overrides = usePreferencesStore((state) => state.values.shortcutOverrides.value);
  const shortcut = configuredCommands(overrides).find(
    (command) => command.id === "commands.open",
  )?.shortcut;
  return (
    <WindowTitlebar>
      {settingsOpen && (
        <Button variant="ghost" size="sm" onClick={onOpenSettings} icon={<ArrowLeft size={14} />}>
          {t("toolbar.backToWorkspace")}
        </Button>
      )}

      <div className="min-w-0 flex-1">{tabs}</div>

      <span aria-hidden="true" className="w-16 shrink-0 self-stretch" />

      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border-default" />

      <Button
        variant="ghost"
        size={labels ? "sm" : "icon"}
        onClick={onOpenCommands}
        data-tour="commands"
        aria-label={t("toolbar.commandPalette")}
        title={
          shortcut
            ? t("toolbar.commandPaletteShortcut", { value1: shortcutLabel(shortcut, platform) })
            : t("toolbar.commandPalette")
        }
        icon={<Search size={15} />}
        className={labels ? "shrink-0" : "size-8 shrink-0"}
      >
        {labels && t("toolbar.commandPalette")}
      </Button>

      <Button
        variant="ghost"
        size={labels ? "sm" : "icon"}
        onClick={onOpenSettings}
        data-tour="settings"
        aria-label={t("common.settings")}
        aria-current={settingsOpen ? "page" : undefined}
        title={t("common.settings")}
        icon={<SettingsIcon />}
        className={cx(!labels && "size-8", settingsOpen && "bg-bg-raised text-text-primary")}
      >
        {labels && t("common.settings")}
      </Button>

      <IdentitySwitcher onAddIdentity={onAddIdentity} onManageProfiles={onManageProfiles} />
    </WindowTitlebar>
  );
}
