import { t } from "@shared/i18n";
import { hasOpenOverlay } from "../../components/ui/overlays/overlay-presence";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { openSettings } from "../../stores/shell-store";
import { useAppStore } from "../../stores/app-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { useSessionStore } from "../../stores/session-store";
import { useLayoutStore } from "../../stores/layout-store";
import { usePreferencesStore } from "../../stores/preferences-store";
import { categorizeChanges } from "../../repository/working-changes";
import {
  dispatchCommand,
  shortcutCommand,
  type CommandContext,
  type ShellCommandId,
} from "../shell-commands";

export interface ShellNavigation {
  workspace: boolean;
  transitionLayout: (update: () => void) => void;
  openCommands: () => void;
  openShortcuts: () => void;
  browse: () => void;
  profiles: () => void;
  createProfile: () => void;
  toggleSettings: () => void;
  showWorkspace: () => void;
}

function contextFor(workspace: boolean): CommandContext {
  const app = useAppStore.getState();
  const repository = useRepositoryStore.getState();
  const session = useSessionStore.getState();
  const profileId = app.activeIdentity?.id ?? null;
  const tabs = profileId ? (app.openTabsByIdentity[profileId] ?? []) : [];
  const changes = categorizeChanges(repository.status?.changes ?? []);

  return {
    profileId,
    repositoryId: app.selectedRepositoryId,
    generation: session.snapshot?.context.generation ?? 0,
    loading: app.loading,
    transitioning: app.switchingIdentityId !== null || session.transitioning,
    workspace,
    tabs,
    editorConfigured: !!usePreferencesStore.getState().values.editorExecutable.value,
    writeUnavailable:
      repository.status?.capabilities?.write === false
        ? (repository.status.capabilities.reason ?? t("useShellCommands.thisRepositoryIsReadOnly"))
        : undefined,
    stagedCount: changes.staged.length,
    unstagedCount: changes.unstaged.length + changes.untracked.length,
    commitOid:
      repository.selection?.kind === "commit"
        ? repository.selection.oid
        : repository.status?.branch.oid,
    available: app.repositories.some((r) => r.id === app.selectedRepositoryId && r.available),
    reading:
      repository.phase === "loading" ||
      repository.repositoryId !== app.selectedRepositoryId ||
      repository.identityId !== profileId,
    writing: repository.writing,
    canReopen: Boolean(
      profileId &&
      app.closedTabsByIdentity[profileId]?.some(
        (tab) => !tabs.includes(tab.id) && app.repositories.some((r) => r.id === tab.id),
      ),
    ),
  };
}

export function useShellCommands(navigation: ShellNavigation) {
  const navigationRef = useRef(navigation);

  navigationRef.current = navigation;

  useAppStore(
    useShallow((s) => [
      s.activeIdentity,
      s.selectedRepositoryId,
      s.openTabsByIdentity,
      s.closedTabsByIdentity,
      s.repositories,
      s.loading,
      s.switchingIdentityId,
    ]),
  );

  useRepositoryStore(useShallow((s) => [s.phase, s.writing, s.status, s.selection]));
  usePreferencesStore((state) => state.values.editorExecutable.value);
  useSessionStore(useShallow((s) => [s.snapshot?.context.generation, s.transitioning]));

  const context = contextFor(navigation.workspace);
  const platform = window.eda.app.platform ?? "windows";

  const execute = (id: ShellCommandId, expected?: CommandContext) =>
    dispatchCommand(
      id,
      contextFor(navigationRef.current.workspace),
      (command, captured) => {
        const app = useAppStore.getState();

        const perform = () => {
          switch (command) {
            case "repository.stash":
              void useRepositoryStore.getState().stash();
              break;
            case "repository.popStash":
              void useRepositoryStore.getState().popStash();
              break;
            case "repository.stageAll":
              void useRepositoryStore.getState().stage();
              break;
            case "repository.unstageAll":
              void useRepositoryStore.getState().unstage();
              break;
            case "repository.editor":
              if (captured.repositoryId)
                void window.eda.repository.openEditor(captured.repositoryId).then((result) => {
                  if (!result.ok) useAppStore.setState({ error: result.error });
                });
              break;
            case "repository.remotes":
              openSettings("repository-remotes");
              break;
            case "repository.references":
            case "repository.graph":
            case "repository.recovery":
            case "repository.historyRecovery":
            case "repository.undoRedo":
            case "repository.createBranch":
            case "repository.createTag":
              useRepositoryStore.setState({
                commandDialog: { kind: command, oid: captured.commitOid },
              });
              break;
            case "commands.open":
              navigationRef.current.openCommands();
              break;
            case "shortcuts.open":
              navigationRef.current.openShortcuts();
              break;
            case "repositories.browse":
              navigationRef.current.browse();
              break;
            case "profiles.manage":
              navigationRef.current.profiles();
              break;
            case "profiles.create":
              navigationRef.current.createProfile();
              break;
            case "settings.toggle":
              navigationRef.current.toggleSettings();
              break;
            case "workspace.show":
              navigationRef.current.showWorkspace();
              break;
            case "repository.refresh":
              void useRepositoryStore.getState().refresh();
              break;
            case "tabs.close":
              if (captured.repositoryId) app.closeTab(captured.repositoryId);
              break;
            case "tabs.reopen":
              app.reopenTab();
              break;
            case "layout.graph":
              useRepositoryStore.setState({ contentView: "history" });
              useLayoutStore.getState().toggleMaximize("graph");
              break;
            case "layout.default":
              useLayoutStore.getState().preset("default");
              break;
            case "layout.compact":
              useLayoutStore.getState().preset("compact");
              break;
            case "layout.diff":
              {
                const repository = useRepositoryStore.getState();
                const focused = useLayoutStore.getState().maximized === "diff";
                const file = repository.diff?.files[0];
                const path = repository.commitFilePath ?? file?.newPath ?? file?.oldPath;

                if (repository.selection?.kind === "commit" && path) {
                  void repository.selectCommitFile(path);
                } else useRepositoryStore.setState({ contentView: "diff" });

                if (focused || useLayoutStore.getState().maximized !== "diff")
                  useLayoutStore.getState().toggleMaximize("diff");
              }
              break;
            case "layout.rail":
              useLayoutStore.getState().toggleMaximize("rail");
              break;
            default: {
              const position = Number(command.slice(4)) - 1;
              const target = captured.tabs[position === 8 ? captured.tabs.length - 1 : position];
              if (target) app.selectRepository(target);
            }
          }
        };

        if (command.startsWith("layout.")) navigationRef.current.transitionLayout(perform);
        else perform();
      },
      expected,
    );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const command = shortcutCommand(event, platform);

      if (!command) return;

      event.preventDefault();

      if (hasOpenOverlay()) return;

      execute(command.id);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return { context, platform, execute };
}
