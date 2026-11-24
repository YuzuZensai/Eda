import { errorText } from "@shared/error-codes";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CollapsiblePanel } from "../components/layout/CollapsiblePanel";
import { usePanel } from "../components/layout/hooks/usePanel";
import { Split } from "../components/layout/Split";
import { LayoutTransition, ViewTransition } from "../components/layout/ViewTransition";
import { Button, Dialog, StateMessage } from "../components/ui/index";
import { ChangesPanel } from "../features/changes/ChangesPanel";
import { CommitBox } from "../features/changes/CommitBox";
import { DiffViewer } from "../features/diff/DiffViewer";
import { CommitChangesPanel } from "../features/history/CommitChangesPanel";
import { CommitGraph } from "../features/history/CommitGraph";
import { ReferenceSidebar } from "../features/references/ReferenceSidebar";
import { MissingRepository } from "../features/repositories/MissingRepository";
import { RepositoryHome } from "../features/repositories/RepositoryHome";
import { RepositoryOverview } from "../features/repositories/RepositoryOverview";
import { useAppStore } from "../stores/app-store";
import { useLayoutStore, type PanelId } from "../stores/layout-store";
import { useRepositoryStore } from "../stores/repository-store";

const WorkspaceDialogs = lazy(() =>
  import("./WorkspaceDialogs").then((module) => ({ default: module.WorkspaceDialogs })),
);

const ConflictEditor = lazy(() =>
  import("../features/changes/ConflictEditor").then((module) => ({
    default: module.ConflictEditor,
  })),
);

const RevisionBrowser = lazy(() =>
  import("../features/history/RevisionBrowser").then((module) => ({
    default: module.RevisionBrowser,
  })),
);

const RevisionComparison = lazy(() =>
  import("../features/history/RevisionComparison").then((module) => ({
    default: module.RevisionComparison,
  })),
);

const PANELS: readonly PanelId[] = ["graph", "diff", "rail"];

export function Workspace() {
  const profileId = useAppStore((state) => state.activeIdentity?.id);
  const repositoryId = useAppStore((state) => state.selectedRepositoryId);

  return (
    <LayoutTransition className="h-full min-h-0">
      <ViewTransition viewKey={`${profileId}:${repositoryId}`} className="h-full min-h-0">
        <WorkspaceContent />
      </ViewTransition>
    </LayoutTransition>
  );
}

function WorkspaceContent() {
  const filesPanel = useRef<HTMLElement>(null);
  const graph = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1100);

  const [drawer, setDrawer] = useState<{ owner: string; kind: "references" | "commit" } | null>(
    null,
  );

  const repositories = useAppStore((state) => state.repositories);
  const selectedId = useAppStore((state) => state.selectedRepositoryId);
  const active = useAppStore((state) => state.activeIdentity);

  const phase = useRepositoryStore((state) =>
    state.repositoryId === selectedId && state.identityId === active?.id ? state.phase : "loading",
  );

  const loading = phase === "loading" || phase === "idle";
  const error = useRepositoryStore((state) => state.error);

  const commandDialog = useRepositoryStore((state) =>
    state.repositoryId === selectedId && state.identityId === active?.id
      ? state.commandDialog
      : null,
  );

  const closeCommand = () => useRepositoryStore.setState({ commandDialog: null });
  const watchWarning = useRepositoryStore((state) => state.watchWarning);

  const writeUnavailable = useRepositoryStore((state) =>
    state.status?.capabilities?.write === false ? state.status.capabilities.reason : undefined,
  );

  const open = useRepositoryStore((state) => state.open);
  const refresh = useRepositoryStore((state) => state.refresh);

  const [graphVisible, diffVisible, railVisible] = useLayoutStore(
    useShallow((state) => PANELS.map(state.isVisible)),
  );

  const graphPanel = usePanel("graph");
  const diffPanel = usePanel("diff");
  const railPanel = usePanel("rail");
  const contentView = useRepositoryStore((state) => state.contentView);
  const selection = useRepositoryStore((state) => state.selection);
  const showingDiff = !loading && contentView === "diff";
  const review = !loading && typeof contentView === "object" ? contentView : null;
  const backToHistory = () => {
    useRepositoryStore.getState().showHistory();
    requestAnimationFrame(() => graph.current?.focus());
  };
  const conflictPath =
    showingDiff && selection?.kind === "change" && selection.area === "conflicted"
      ? selection.path
      : null;
  const workflow = useRepositoryStore((state) => state.status?.workflow);
  const inspectingCommit = !loading && selection?.kind === "commit";
  const contentVisible = showingDiff ? diffVisible : graphVisible;
  const contentPanel = showingDiff ? diffPanel : graphPanel;
  const changeCount = useRepositoryStore((state) => state.status?.changes.length);
  const selected = repositories.find((repository) => repository.id === selectedId);
  const owner = `${active?.id}:${selectedId}`;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1099px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!selected || !active) {
      useRepositoryStore.getState().clear();
      return;
    }

    void open(selected.id, active.id, selected.available);
  }, [active, open, selected]);

  if (!selected) {
    return <RepositoryHome />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {drawer?.owner === owner && (
        <Dialog
          placement="right"
          title={
            drawer.kind === "references"
              ? t("workspace.branchesAndTags")
              : t("workspace.commitDraft")
          }
          onClose={() => setDrawer(null)}
          footer={
            <Button variant="quiet" onClick={() => setDrawer(null)}>
              {t("workspace.closeDrawer")}
            </Button>
          }
        >
          {drawer.kind === "references" ? (
            <div className="mt-4 h-[70vh]">
              <ReferenceSidebar
                repositoryId={selected.id}
                forceExpanded
                onExpand={() => setDrawer(null)}
              />
            </div>
          ) : (
            <CommitBox key={owner} />
          )}
        </Dialog>
      )}

      {commandDialog && (
        <Suspense fallback={null}>
          <WorkspaceDialogs
            key={owner}
            command={commandDialog}
            repositoryId={selected.id}
            onClose={closeCommand}
          />
        </Suspense>
      )}

      {phase === "missing" && <MissingRepository key={selected.id} repository={selected} />}

      {phase === "error" && (
        <StateMessage
          tone="error"
          className="min-h-0 flex-1"
          title={t("workspace.repositoryCouldNotBeRead")}
          description={errorMessage(error, errorText("workspace.anUnexpectedReadErrorOccurred"))}
          action={<Button onClick={() => void refresh()}>{t("workspace.tryAgain")}</Button>}
        />
      )}

      {(loading || phase === "ready") && (
        <>
          <RepositoryOverview
            pending={loading}
            key={owner}
            repository={selected}
            {...(!railVisible &&
              !workflow && { onOpenCommit: () => setDrawer({ owner, kind: "commit" }) })}
          />

          {!loading && watchWarning && (
            <p role="status" className="px-3 py-1 text-xs text-git-modified">
              {watchWarning}
            </p>
          )}

          {!loading && writeUnavailable && (
            <p role="status" className="px-3 py-1 text-xs text-git-modified">
              {writeUnavailable}
            </p>
          )}

          {conflictPath && (
            <Suspense
              fallback={
                <StateMessage
                  className="flex-1"
                  tone="loading"
                  title={t("conflicts.openingFile")}
                />
              }
            >
              <ConflictEditor
                key={JSON.stringify([owner, conflictPath])}
                repositoryId={selected.id}
                path={conflictPath}
                onBack={() => {
                  useRepositoryStore.getState().showWorkingTree();
                  requestAnimationFrame(() => filesPanel.current?.focus());
                }}
              />
            </Suspense>
          )}
          {review && (
            <Suspense
              fallback={
                <StateMessage
                  tone="loading"
                  className="flex-1"
                  title={t(review.kind === "tree" ? "revision.snapshot" : "comparison.title")}
                />
              }
            >
              {review.kind === "tree" ? (
                <RevisionBrowser
                  key={JSON.stringify([owner, review.oid, review.path])}
                  initialPath={review.path ?? ""}
                  repositoryName={selected.name}
                  repositoryId={selected.id}
                  oid={review.oid}
                  onBack={backToHistory}
                />
              ) : (
                <RevisionComparison
                  key={JSON.stringify([owner, review.left, review.right])}
                  repositoryId={selected.id}
                  initialLeft={review.left}
                  initialRight={review.right}
                  onBack={backToHistory}
                />
              )}
            </Suspense>
          )}

          <div className={conflictPath || review ? "hidden" : "flex min-h-0 flex-1"}>
            <ReferenceSidebar
              key={`${active?.id}:${selected.id}`}
              repositoryId={selected.id}
              compact={narrow || showingDiff}
              pending={loading}
              onExpand={() => setDrawer({ owner, kind: "references" })}
            />

            <Split
              direction="horizontal"
              className="flex-1"
              storageKey="eda.layout.rail"
              label={t("workspace.resizeTheWorkingTreePanel")}
              defaultFraction={0.73}
              minFirst={340}
              minSecond={260}
              collapsed={!contentVisible ? "first" : railVisible ? undefined : "second"}
              first={
                <CollapsiblePanel
                  collapsed={!contentVisible}
                  name={showingDiff ? t("workspace.diffViewer") : t("workspace.history")}
                  onExpand={contentPanel.toggleCollapse}
                >
                  <ViewTransition
                    key={owner}
                    viewKey={showingDiff ? "diff" : "history"}
                    motion={showingDiff ? "forward" : "back"}
                    className="h-full w-full"
                  >
                    <div className="h-full w-full" hidden={showingDiff} inert={showingDiff}>
                      <CommitGraph key={owner} pending={loading} ref={graph} />
                    </div>
                    <div className="h-full w-full" hidden={!showingDiff} inert={!showingDiff}>
                      {showingDiff && !conflictPath && <DiffViewer key={owner} />}
                    </div>
                  </ViewTransition>
                </CollapsiblePanel>
              }
              second={
                <CollapsiblePanel
                  collapsed={!railVisible}
                  name={inspectingCommit ? t("workspace.fileChanges") : t("workspace.workingTree")}
                  onExpand={railPanel.toggleCollapse}
                  badge={changeCount ? String(changeCount) : undefined}
                >
                  <ViewTransition
                    key={owner}
                    viewKey={inspectingCommit ? "commit" : "working"}
                    className="app-canvas flex h-full min-h-0 w-full flex-col border-l border-border-subtle bg-bg-surface"
                  >
                    {inspectingCommit ? (
                      <CommitChangesPanel key={owner} />
                    ) : (
                      <>
                        <div className="min-h-0 flex-1">
                          <ChangesPanel ref={filesPanel} key={owner} pending={loading} />
                        </div>
                        {!workflow && (
                          <div className="max-h-3/5 shrink-0 overflow-y-auto">
                            <CommitBox key={owner} pending={loading} />
                          </div>
                        )}
                      </>
                    )}
                  </ViewTransition>
                </CollapsiblePanel>
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
