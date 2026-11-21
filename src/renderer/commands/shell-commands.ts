import type { DesktopPlatform } from "@shared/application";
import { t } from "@shared/i18n";
import { createTextSearch } from "../utils/search";
export type { DesktopPlatform } from "@shared/application";

export type ShellCommandId =
  | "repository.undoRedo"
  | "repository.historyRecovery"
  | "repository.stash"
  | "repository.popStash"
  | "repository.remotes"
  | "repository.stageAll"
  | "repository.unstageAll"
  | "repository.references"
  | "repository.graph"
  | "repository.compare"
  | "repository.recovery"
  | "repository.editor"
  | "repository.createBranch"
  | "repository.createTag"
  | "commands.open"
  | "shortcuts.open"
  | "repositories.browse"
  | "profiles.manage"
  | "profiles.create"
  | "settings.toggle"
  | "workspace.show"
  | "repository.refresh"
  | "tabs.close"
  | "tabs.reopen"
  | "layout.graph"
  | "layout.diff"
  | "layout.rail"
  | "layout.default"
  | "layout.compact"
  | `tab.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export interface CommandContext {
  profileId: string | null;
  repositoryId: string | null;
  generation: number;
  loading: boolean;
  transitioning: boolean;
  workspace: boolean;
  available: boolean;
  reading: boolean;
  writing: boolean;
  tabs: readonly string[];
  canReopen: boolean;
  editorConfigured?: boolean;
  writeUnavailable?: string | undefined;
  stagedCount?: number;
  unstagedCount?: number;
  commitOid?: string | undefined;
}

export interface Shortcut {
  key: string;
  shift?: boolean;
}

export interface ShellCommand {
  id: ShellCommandId;
  title: string;
  group: string;
  keywords: string;
  shortcut?: Shortcut;
  requirement?: "repository" | "tab" | "closed-tab";
  position?: number;
}

export const SHELL_COMMANDS: readonly ShellCommand[] = [
  {
    id: "repository.undoRedo",
    title: t("shellCommands.undoAndRedoLocalActions"),
    group: t("shellCommands.history"),
    keywords: t("shellCommands.reverseResetRecoverHistory"),
    requirement: "repository",
  },
  {
    id: "repository.historyRecovery",
    title: t("shellCommands.reflogAndHistoryRecovery"),
    group: t("shellCommands.history"),
    keywords: t("shellCommands.lostCommitsDeletedBranchesRestoreUnreachableResetReflog"),
    requirement: "repository",
  },
  {
    id: "repository.stash",
    title: t("stashActions.stashAllChanges"),
    group: t("shellCommands.repository"),
    keywords: t("shellCommands.saveUnfinishedWorkStash"),
    requirement: "repository",
  },
  {
    id: "repository.popStash",
    title: t("stashActions.popLatestStash"),
    group: t("shellCommands.repository"),
    keywords: t("stashActions.restoreSavedWork"),
    requirement: "repository",
  },
  {
    id: "repository.remotes",
    title: t("shellCommands.manageBranchTracking"),
    group: t("shellCommands.remotes"),
    keywords: t("shellCommands.remotesUpstreamTrackingConfiguration"),
    requirement: "repository",
  },
  {
    id: "repository.stageAll",
    title: t("shellCommands.stageAllWorkingChanges"),
    group: t("shellCommands.changes"),
    keywords: t("shellCommands.indexAddFiles"),
    requirement: "repository",
  },
  {
    id: "repository.unstageAll",
    title: t("shellCommands.unstageAllChanges"),
    group: t("shellCommands.changes"),
    keywords: t("shellCommands.indexRemoveFiles"),
    requirement: "repository",
  },
  {
    id: "repository.references",
    title: t("shellCommands.manageLocalReferences"),
    group: t("shellCommands.references"),
    keywords: t("shellCommands.branchesTagsFoldersDeleteBulk"),
    requirement: "repository",
  },
  {
    id: "repository.createBranch",
    title: t("shellCommands.createBranchAtSelectionOrHead"),
    group: t("shellCommands.references"),
    keywords: t("shellCommands.newBranchCommit"),
    requirement: "repository",
  },
  {
    id: "repository.createTag",
    title: t("shellCommands.createTagAtSelectionOrHead"),
    group: t("shellCommands.references"),
    keywords: t("shellCommands.newAnnotatedLightweightTagCommit"),
    requirement: "repository",
  },
  {
    id: "repository.compare",
    title: t("comparison.title"),
    group: t("shellCommands.history"),
    keywords: t("comparison.keywords"),
    requirement: "repository",
  },
  {
    id: "repository.graph",
    title: t("shellCommands.graphVisibilityAndPinning"),
    group: t("shellCommands.history"),
    keywords: t("shellCommands.soloHideShowBranchesRemotesFocus"),
    requirement: "repository",
  },
  {
    id: "repository.recovery",
    title: t("shellCommands.recoverLocalFiles"),
    group: t("shellCommands.changes"),
    keywords: t("shellCommands.snapshotRestoreSavedCopies"),
    requirement: "repository",
  },
  {
    id: "repository.editor",
    title: t("shellCommands.openRepositoryInEditor"),
    group: t("shellCommands.repository"),
    keywords: t("shellCommands.externalToolCode"),
    requirement: "repository",
  },
  {
    id: "layout.default",
    title: t("shellCommands.restoreDefaultLayout"),
    group: t("shellCommands.layout"),
    keywords: t("shellCommands.resetPanesSizesVisibility"),
    requirement: "repository",
  },
  {
    id: "layout.compact",
    title: t("shellCommands.useCompactLayout"),
    group: t("shellCommands.layout"),
    keywords: t("shellCommands.presetPanesSpaceNavigation"),
    requirement: "repository",
  },
  {
    id: "commands.open",
    title: t("shellCommands.showCommandPalette"),
    group: t("shellCommands.navigation"),
    keywords: t("shellCommands.searchActionsCommands"),
    shortcut: { key: "p", shift: true },
  },
  {
    id: "shortcuts.open",
    title: t("shellCommands.keyboardShortcuts"),
    group: t("shellCommands.navigation"),
    keywords: t("shellCommands.helpKeysReference"),
    shortcut: { key: "/" },
  },
  {
    id: "repositories.browse",
    title: t("shellCommands.openARepository"),
    group: t("shellCommands.navigation"),
    keywords: t("shellCommands.browseFolderRecentSwitch"),
    shortcut: { key: "p" },
  },
  {
    id: "profiles.manage",
    title: t("shellCommands.manageProfiles"),
    group: t("shellCommands.profiles"),
    keywords: t("shellCommands.switchIdentityAuthorPreferencesDuplicateDelete"),
  },
  {
    id: "profiles.create",
    title: t("shellCommands.createAProfile"),
    group: t("shellCommands.profiles"),
    keywords: t("shellCommands.newIdentityAuthor"),
  },
  {
    id: "settings.toggle",
    title: t("shellCommands.toggleSettings"),
    group: t("shellCommands.navigation"),
    keywords: t("shellCommands.preferencesApplicationConfiguration"),
    shortcut: { key: "," },
  },
  {
    id: "workspace.show",
    title: t("shellCommands.backToWorkspace"),
    group: t("shellCommands.navigation"),
    keywords: t("shellCommands.repositoryHistoryChanges"),
  },
  {
    id: "repository.refresh",
    title: t("shellCommands.refreshRepository"),
    group: t("shellCommands.repository"),
    keywords: t("shellCommands.reloadStatusHistoryDisk"),
    shortcut: { key: "r" },
    requirement: "repository",
  },
  {
    id: "tabs.close",
    title: t("shellCommands.closeRepositoryTab"),
    group: t("shellCommands.tabs"),
    keywords: t("shellCommands.closeCurrent"),
    shortcut: { key: "w" },
    requirement: "tab",
  },
  {
    id: "tabs.reopen",
    title: t("shellCommands.reopenClosedRepository"),
    group: t("shellCommands.tabs"),
    keywords: t("shellCommands.restoreLastClosedTab"),
    shortcut: { key: "t", shift: true },
    requirement: "closed-tab",
  },
  {
    id: "layout.graph",
    title: t("shellCommands.toggleHistoryFocus"),
    group: t("shellCommands.layout"),
    keywords: t("shellCommands.maximizeRestoreGraphPane"),
    requirement: "repository",
  },
  {
    id: "layout.diff",
    title: t("shellCommands.toggleDiffFocus"),
    group: t("shellCommands.layout"),
    keywords: t("shellCommands.maximizeRestoreChangesComparisonPane"),
    requirement: "repository",
  },
  {
    id: "layout.rail",
    title: t("shellCommands.toggleWorkingTreeFocus"),
    group: t("shellCommands.layout"),
    keywords: t("shellCommands.maximizeRestoreStageCommitPane"),
    requirement: "repository",
  },
  ...Array.from({ length: 9 }, (_, index): ShellCommand => ({
    id: `tab.${index + 1}` as ShellCommandId,
    title:
      index === 8
        ? t("shellCommands.selectLastRepositoryTab")
        : t("shellCommands.selectRepositoryTab", { value1: index + 1 }),
    group: t("shellCommands.tabs"),
    keywords: t("shellCommands.switchNavigatePosition"),
    shortcut: { key: String(index + 1) },
    position: index,
  })),
];

export function commandReason(command: ShellCommand, context: CommandContext): string | null {
  if (context.loading) return t("shellCommands.edaIsStarting");
  if (context.transitioning) return t("shellCommands.waitForTheProfileSwitchToFinish");
  if (!context.profileId) return t("shellCommands.createOrSelectAProfileFirst");

  if (command.requirement || command.position !== undefined) {
    if (!context.workspace) return t("shellCommands.returnToTheWorkspaceFirst");

    if (command.position !== undefined)
      return context.tabs[command.position === 8 ? context.tabs.length - 1 : command.position]
        ? null
        : t("shellCommands.thereIsNoRepositoryTabAtThisPosition");

    if (command.requirement === "closed-tab")
      return context.canReopen ? null : t("shellCommands.noRecentlyClosedRepositoryInThisProfile");
    if (!context.repositoryId) return t("shellCommands.selectARepositoryFirst");

    if (command.requirement === "repository") {
      if (!context.available) return t("shellCommands.locateTheMissingRepositoryFirst");
      if (context.writing) return t("shellCommands.waitForTheRepositoryOperationToFinish");
      if (context.reading) return t("shellCommands.waitForTheRepositoryToFinishLoading");
    }
  }

  if (
    context.writeUnavailable &&
    [
      "repository.stash",
      "repository.popStash",
      "repository.stageAll",
      "repository.unstageAll",
      "repository.createBranch",
      "repository.createTag",
    ].includes(command.id)
  )
    return context.writeUnavailable;

  if (command.id === "repository.stash" && !context.stagedCount && !context.unstagedCount)
    return t("stashActions.noChanges");

  if (command.id === "repository.editor" && !context.editorConfigured)
    return t("shellCommands.chooseAnEditorExecutableInApplicationPreferences");
  if (command.id === "repository.stageAll" && !context.unstagedCount)
    return t("shellCommands.thereAreNoWorkingChangesToStage");
  if (command.id === "repository.unstageAll" && !context.stagedCount)
    return t("shellCommands.thereAreNoStagedChanges");

  if (
    (command.id === "repository.createBranch" || command.id === "repository.createTag") &&
    !context.commitOid
  )
    return t("shellCommands.selectACommitOrCreateTheFirstCommitInThisRepository");

  return null;
}

export function configuredCommands(
  overrides: Readonly<Record<string, string>>,
): readonly ShellCommand[] {
  const taken = new Set(Object.values(overrides));
  return SHELL_COMMANDS.map((command) => {
    const custom = overrides[command.id];
    const previous = command.shortcut;
    if (
      custom === undefined &&
      (!previous || !taken.has((previous.shift ? "shift+" : "") + previous.key))
    )
      return command;
    const { shortcut: _previous, ...rest } = command;
    if (!custom) return rest;
    return { ...rest, shortcut: { key: custom.slice(-1), shift: custom.startsWith("shift+") } };
  });
}

export function searchCommands(query: string, commands = SHELL_COMMANDS): readonly ShellCommand[] {
  const matches = createTextSearch(query);
  return commands.filter((command) =>
    matches(`${command.title} ${command.group} ${command.keywords}`),
  );
}

export function shortcutLabel(shortcut: Shortcut, platform: DesktopPlatform): string {
  return `${platform === "mac" ? t("shellCommands.cmd") : t("shellCommands.ctrl")}+${shortcut.shift ? t("shellCommands.shiftModifier") : ""}${shortcut.key.toUpperCase()}`;
}

export function shortcutCommand(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "repeat"
  >,
  platform: DesktopPlatform,
  commands = SHELL_COMMANDS,
): ShellCommand | undefined {
  if (event.altKey || event.isComposing || event.repeat) return undefined;
  if (platform === "mac" ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)
    return undefined;

  return commands.find(
    ({ shortcut }) =>
      shortcut &&
      shortcut.key === event.key.toLowerCase() &&
      Boolean(shortcut.shift) === event.shiftKey,
  );
}

export function sameCommandContext(left: CommandContext, right: CommandContext): boolean {
  return (
    left.profileId === right.profileId &&
    left.repositoryId === right.repositoryId &&
    left.generation === right.generation &&
    left.workspace === right.workspace
  );
}

export function dispatchCommand(
  id: ShellCommandId,
  context: CommandContext,
  execute: (id: ShellCommandId, context: CommandContext) => void,
  expected?: CommandContext,
): boolean {
  const command = SHELL_COMMANDS.find((item) => item.id === id);

  if (
    !command ||
    (expected && !sameCommandContext(expected, context)) ||
    commandReason(command, context)
  )
    return false;

  execute(id, context);

  return true;
}
