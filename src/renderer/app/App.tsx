import { redactDiagnostic } from "@shared/diagnostics";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useShellCommands } from "../commands/hooks/useShellCommands";
import { RetainedView } from "../components/layout/ViewTransition";
import { useViewTransition } from "../components/layout/hooks/useViewTransition";
import { TextButton } from "../components/ui/actions/TextButton";
import { ErrorDialog } from "../components/ui/index";
import { IdentityDialog } from "../features/profiles/IdentityDialog";
import { RepositoryPicker } from "../features/repositories/RepositoryPicker";
import { RepositoryTabs } from "../features/repositories/RepositoryTabs";
import type { SettingsSection } from "../features/settings/settings-sections";
import {
  showOpenedRepository,
  useRepositoryNavigation,
} from "../repository/hooks/useRepositoryNavigation";
import { useRepositoryWatch } from "../repository/hooks/useRepositoryWatch";
import { useAppStore } from "../stores/app-store";
import { watchSystemAppearance } from "../stores/preferences-store";
import { useSessionStore } from "../stores/session-store";
import { useShellStore } from "../stores/shell-store";
import { TourHost } from "../tutorial/TourHost";
import { AppErrorDialog } from "./AppErrorDialog";
import { AppNotices } from "./AppNotices";
import { CommandPalette } from "./CommandPalette";
import { FailureScreen } from "./RendererFailure";
import { ShortcutHelp } from "./ShortcutHelp";
import { Toolbar } from "./Toolbar";
import { WindowTitlebar } from "./WindowControls";
import { Workspace } from "./Workspace";
import { WorkspaceFrame } from "./WorkspaceFrame";

const FirstRun = lazy(() =>
  import("../features/onboarding/FirstRun").then((module) => ({ default: module.FirstRun })),
);

const Settings = lazy(() =>
  import("../features/settings/Settings").then((module) => ({ default: module.Settings })),
);

export function App() {
  useEffect(watchSystemAppearance, []);

  const initialize = useAppStore((s) => s.initialize);
  const loading = useAppStore((s) => s.loading);
  const identities = useAppStore((s) => s.identities);
  const activeProfileId = useAppStore((s) => s.activeIdentity?.id);
  const switching = useAppStore((s) => s.switchingIdentityId);

  useRepositoryWatch(!loading && !switching);

  const sessionError = useSessionStore((s) => s.error);
  const recovery = useSessionStore((s) => s.snapshot?.recovery);
  const [tour, setTour] = useState(false);

  const [onboarding, setOnboarding] = useState(false);

  useEffect(() => {
    if (!loading && identities.length === 0) setOnboarding(true);
  }, [loading, identities.length]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [view, updateView] = useState<"repositories" | "settings">("repositories");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("profiles");
  const requestedView = useRef(view);
  const navigation = useViewTransition();
  const onboardingTransition = useViewTransition();

  const closeTour = useCallback(() => {
    onboardingTransition.transition(() => {
      setTour(false);
      setOnboarding(false);
    }, "forward");
  }, [onboardingTransition.transition]);

  const setView = useCallback(
    (
      next:
        | "repositories"
        | "settings"
        | ((current: "repositories" | "settings") => "repositories" | "settings"),
      section?: SettingsSection,
    ) => {
      const target = typeof next === "function" ? next(requestedView.current) : next;

      if (target === requestedView.current) {
        if (section !== undefined) setSettingsSection(section);
        return;
      }

      requestedView.current = target;

      navigation.transition(
        () => {
          if (section !== undefined) setSettingsSection(section);
          updateView(target);
        },
        target === "settings" ? "forward" : "back",
      );
    },
    [navigation.transition],
  );

  const showWorkspace = useCallback(() => setView("repositories"), [setView]);

  useRepositoryNavigation(loading || switching ? undefined : activeProfileId, showWorkspace);

  const shellRequest = useShellStore((state) => state.request);

  useEffect(() => {
    if (!shellRequest) return;

    if (shellRequest.kind === "settings") {
      setView("settings", shellRequest.section);
    } else setTour(true);

    useShellStore.getState().consume(shellRequest);
  }, [shellRequest, setView]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const pendingCommand = useRef<(() => void) | null>(null);
  const [commandMode, setCommandMode] = useState<"palette" | "shortcuts" | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);

  const commands = useShellCommands({
    workspace: view === "repositories",
    transitionLayout: (update) => navigation.transition(update, "layout"),
    openCommands: () => setCommandMode("palette"),
    openShortcuts: () => setCommandMode("shortcuts"),
    browse: () => {
      setView("repositories");
      setPickerOpen(true);
    },
    profiles: () => {
      setView("settings", "profiles");
    },
    createProfile: () => setDialogOpen(true),
    toggleSettings: () =>
      setView((current) => (current === "settings" ? "repositories" : "settings")),
    showWorkspace: () => setView("repositories"),
  });

  useEffect(() => {
    void initialize().catch((error: unknown) => {
      const detail = errorMessage(error);
      setStartupError(redactDiagnostic(detail || t("app.startupFailedUnexpectedly")));
    });
  }, [initialize]);

  if (startupError) return <FailureScreen detail={startupError} />;

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <WindowTitlebar />
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-text-tertiary">{t("app.startingEda")}</span>
        </div>
      </div>
    );
  }

  if (identities.length === 0 || onboarding) {
    return (
      <div ref={onboardingTransition.ref} className="flex h-full flex-col">
        <WindowTitlebar />

        <div className="min-h-0 flex-1" inert={tour} aria-busy={tour}>
          <Suspense fallback={null}>
            <FirstRun
              onComplete={(takeTour = false) => {
                if (takeTour) setTour(true);
                else onboardingTransition.transition(() => setOnboarding(false), "forward");
              }}
            />
          </Suspense>
        </div>

        {tour && <TourHost onClose={closeTour} />}
      </div>
    );
  }

  return (
    <div
      ref={onboardingTransition.ref}
      className="relative flex h-full flex-col"
      aria-busy={switching !== null}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;

        event.preventDefault();

        if (tour || !activeProfileId || switching) return;

        const files = [...event.dataTransfer.files].slice(0, 10);

        void (async () => {
          for (const file of files) {
            if (useAppStore.getState().activeIdentity?.id !== activeProfileId) return;

            const opened = await window.eda.repository.openDropped(file);

            if (!opened.ok) useAppStore.setState({ error: opened.error });
            else {
              showWorkspace();
              await showOpenedRepository(opened.value, activeProfileId);
            }
          }
        })();
      }}
    >
      {tour && <TourHost onClose={closeTour} />}

      <div className="contents" inert={tour}>
        <Toolbar
          onAddIdentity={() => commands.execute("profiles.create")}
          onManageProfiles={() => commands.execute("profiles.manage")}
          onOpenSettings={() => commands.execute("settings.toggle")}
          onOpenCommands={() => commands.execute("commands.open")}
          platform={commands.platform}
          settingsOpen={view === "settings"}
          tabs={view === "repositories" ? <RepositoryTabs /> : undefined}
        />

        <AppErrorDialog />

        <AppNotices
          aboutOpen={view === "settings" && settingsSection === "about"}
          onReviewGitSettings={() => {
            setView("settings", "global-git");
          }}
        />

        {(sessionError || recovery) && (
          <ErrorDialog
            key={sessionError || recovery}
            title={t("app.couldNotSaveOrRestoreTheWorkspace")}
          >
            <span className="flex-1">
              {sessionError || recovery}{" "}
              {sessionError && t("app.yourInputIsStillInThisWindowSwitching")}
            </span>

            {sessionError && (
              <TextButton onClick={() => void useSessionStore.getState().flush()}>
                {t("app.retrySave")}
              </TextButton>
            )}

            {recovery && (
              <TextButton
                onClick={() =>
                  void useSessionStore
                    .getState()
                    .reset()
                    .then((ok) => {
                      if (ok) void useAppStore.getState().refreshRepositories();
                    })
                }
              >
                {t("app.resetSavedStateKeepRecoveryCopy")}
              </TextButton>
            )}
          </ErrorDialog>
        )}

        <WorkspaceFrame
          contentRef={navigation.ref}
          settings={view === "settings"}
          profileId={activeProfileId}
        >
          <RetainedView active={view === "repositories"}>
            <Workspace />
          </RetainedView>

          {view === "settings" && (
            <Suspense fallback={null}>
              <Settings
                selected={settingsSection}
                onSelect={(section) => {
                  setSettingsSection(section);
                }}
              />
            </Suspense>
          )}
        </WorkspaceFrame>

        {pickerOpen && <RepositoryPicker onClose={() => setPickerOpen(false)} />}
        {dialogOpen && <IdentityDialog onClose={() => setDialogOpen(false)} />}

        {commandMode === "palette" && (
          <CommandPalette
            context={commands.context}
            platform={commands.platform}
            onClose={() => setCommandMode(null)}
            onRun={(id, expected) => {
              pendingCommand.current = () => commands.execute(id, expected);
              setCommandMode(null);
            }}
            onAfterClose={() => {
              const run = pendingCommand.current;
              pendingCommand.current = null;
              run?.();
            }}
          />
        )}

        {commandMode === "shortcuts" && (
          <ShortcutHelp platform={commands.platform} onClose={() => setCommandMode(null)} />
        )}

        {switching !== null && (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center bg-bg-base/70"
            role="status"
          >
            {t("app.switchingProfile")}
          </div>
        )}
      </div>
    </div>
  );
}
