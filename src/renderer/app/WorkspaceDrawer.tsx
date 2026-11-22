import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { stateLabel } from "@shared/i18n/labels";
import type { OperationRecord } from "@shared/operations";
import { lazy, Suspense, useId, useState } from "react";
import { RetainedView } from "../components/layout/ViewTransition";
import { useLayoutTransition } from "../components/layout/hooks/useLayoutTransition";
import {
  CodeBlock,
  Collapse,
  Disclosure,
  ErrorDialog,
  IconButton,
  StateMessage,
  TabTrigger,
  TextButton,
} from "../components/ui/index";
import { navigateTabList } from "../components/ui/display/TabTrigger";
import { ActivityIcon, ChevronUpIcon, MonitorIcon, RefreshIcon } from "../components/ui/icons";
import { BackgroundFetchPanel } from "../features/sync/BackgroundFetchPanel";
import { useOperationRecords } from "../hooks/useOperationRecords";
import { useAppStore } from "../stores/app-store";
import { useRepositoryStore } from "../stores/repository-store";
import { formatDateTime } from "../utils/format";

const TerminalSessions = lazy(() => import("../features/repositories/TerminalSessions"));

const drawerTabs = [
  { id: "activity", label: "activityPanel.activity", icon: ActivityIcon },
  { id: "terminal", label: "terminal.title", icon: MonitorIcon },
] as const;
type DrawerTab = (typeof drawerTabs)[number]["id"];

export function WorkspaceDrawer({
  profileId,
  settings,
}: {
  profileId?: string | undefined;
  settings?: boolean;
}) {
  const id = useId();
  const transition = useLayoutTransition();
  const label = t("workspace.drawer");
  const [drawer, setDrawer] = useState<{ tab: DrawerTab; open: boolean }>({
    tab: "activity",
    open: false,
  });
  const [terminalVisited, setTerminalVisited] = useState(false);
  const selectedId = useAppStore((state) => state.selectedRepositoryId);
  const ready = useRepositoryStore(
    (state) =>
      state.phase === "ready" &&
      state.repositoryId === selectedId &&
      state.identityId === profileId,
  );
  const terminalAvailable = ready && !settings;
  const tabs = terminalAvailable ? drawerTabs : drawerTabs.slice(0, 1);
  const tab = terminalAvailable ? drawer.tab : "activity";
  const open = drawer.open && tab === drawer.tab;
  const terminalOpen = open && tab === "terminal";
  if (terminalOpen && !terminalVisited) setTerminalVisited(true);

  const { records, error } = useOperationRecords();
  const running = records.filter(
    (record) => record.state === "queued" || record.state === "running",
  );
  const current = running.find((record) => record.repositoryId === selectedId) ?? running[0];
  const summary = current && `${current.repositoryName}, ${current.message}`;

  const selectDrawer = (value: DrawerTab, nextOpen: boolean) => {
    const update = () => setDrawer({ tab: value, open: nextOpen });
    if (nextOpen === open) update();
    else transition(update, "drawer");
  };
  const toggleDrawer = () => selectDrawer(tab, !open);

  return (
    <section
      aria-label={label}
      data-layout-region=""
      className="workspace-drawer app-surface-chrome"
    >
      <header>
        <div role="tablist" aria-label={label} onKeyDown={navigateTabList}>
          {tabs.map(({ id: value, label, icon: Icon }) => (
            <TabTrigger
              key={value}
              id={`${id}-${value}-tab`}
              aria-controls={`${id}-${value}`}
              selected={value === tab}
              tabIndex={value === tab ? 0 : -1}
              onClick={() => selectDrawer(value, true)}
            >
              <Icon size={13} aria-hidden="true" />
              {t(label)}
            </TabTrigger>
          ))}
        </div>

        {summary && (
          <div role="status">
            <span>{t("activityPanel.running", { active: running.length })}</span>
            <span title={summary}>{summary}</span>
          </div>
        )}

        <IconButton
          size="xs"
          aria-label={label}
          aria-expanded={open}
          aria-controls={id}
          onClick={toggleDrawer}
          icon={<ChevronUpIcon size={13} className="bottom-panel-chevron" data-open={open} />}
        />
      </header>

      <Collapse id={id} className="workspace-drawer-content" open={open}>
        {drawerTabs.map(({ id: value }) => (
          <div
            key={value}
            id={`${id}-${value}`}
            role="tabpanel"
            aria-labelledby={`${id}-${value}-tab`}
            hidden={tab !== value}
          >
            {value === "activity" ? (
              <ActivityLog
                open={open && tab === "activity"}
                records={records}
                loadError={error}
                selectedRepositoryId={selectedId}
              />
            ) : (
              terminalVisited &&
              ready &&
              selectedId &&
              profileId && (
                <RetainedView key={selectedId} active={terminalOpen}>
                  <Suspense
                    fallback={<StateMessage tone="loading" title={t("terminal.loading")} />}
                  >
                    <TerminalSessions id={selectedId} profileId={profileId} onHide={toggleDrawer} />
                  </Suspense>
                </RetainedView>
              )
            )}
          </div>
        ))}
      </Collapse>
    </section>
  );
}

const activityActions = [
  ["cancel", "cancellable", "danger", "common.cancelOperation"],
  ["retry", "retryable", "accent", "activityPanel.retryAgainstCurrentState"],
] as const;

function ActivityLog({
  open,
  records,
  loadError,
  selectedRepositoryId,
}: {
  open: boolean;
  records: OperationRecord[];
  loadError: string | null;
  selectedRepositoryId: string | null;
}) {
  const repositories = useAppStore((state) => state.repositories);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, action: "cancel" | "retry") => {
    setBusy(id);
    setError(null);

    try {
      const result = await window.eda.operations[action](id);
      if (!result.ok) setError(errorMessage(result.error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="activity-log">
      {open && selectedRepositoryId && (
        <BackgroundFetchPanel key={selectedRepositoryId} repositoryId={selectedRepositoryId} />
      )}

      <ErrorDialog
        onDismiss={() => {
          setError(null);
          setDismissedError(loadError);
        }}
      >
        {error ?? (loadError !== dismissedError ? loadError : null)}
      </ErrorDialog>

      <div className="activity-records">
        {records.length === 0 && (
          <p className="p-4 text-sm text-text-tertiary">
            {t("activityPanel.gitOperationsWillAppearHere")}
          </p>
        )}

        {records.map((record) => (
          <Disclosure
            key={record.id}
            title={
              <>
                <span className="w-20 shrink-0 capitalize text-text-tertiary">
                  {stateLabel(record.state)}
                </span>
                <strong className="font-medium">{record.kind}</strong>
                <span className="truncate text-text-tertiary">{record.repositoryName}</span>

                <span className="ml-auto text-text-tertiary">
                  {record.durationMs
                    ? t("activityPanel.durationSeconds", {
                        value1: (record.durationMs / 1000).toFixed(1),
                      })
                    : "..."}
                </span>
              </>
            }
          >
            <div className="space-y-2 px-4 pb-3">
              <p>{record.message}</p>
              {record.recovery && <p className="text-git-modified">{record.recovery}</p>}

              <p className="text-text-tertiary">
                {formatDateTime(record.startedAt)}
                {record.exitCode !== undefined &&
                  t("activityPanel.exit", { exitCode: record.exitCode })}
              </p>

              {record.output && (
                <CodeBlock label={t("activityPanel.operationOutput")} wrap className="max-h-32">
                  {record.output}
                </CodeBlock>
              )}

              <div className="flex items-center gap-4">
                {activityActions.map(
                  ([action, available, tone, label]) =>
                    record[available] && (
                      <TextButton
                        key={action}
                        disabled={busy === record.id}
                        tone={tone}
                        onClick={() => void run(record.id, action)}
                      >
                        {t(label)}
                      </TextButton>
                    ),
                )}

                <TextButton
                  disabled={
                    !repositories.some((repository) => repository.id === record.repositoryId)
                  }
                  className="inline-flex items-center gap-1"
                  onClick={() => {
                    const alreadySelected =
                      useAppStore.getState().selectedRepositoryId === record.repositoryId;
                    useAppStore.getState().selectRepository(record.repositoryId);
                    if (alreadySelected) void useRepositoryStore.getState().refresh();
                  }}
                >
                  <RefreshIcon size={12} />
                  {record.kindKey === "operationTitles.cloneRepository" &&
                  record.state === "succeeded"
                    ? t("activityPanel.openClone")
                    : t("activityPanel.inspectRepository")}
                </TextButton>
              </div>
            </div>
          </Disclosure>
        ))}
      </div>
    </div>
  );
}
