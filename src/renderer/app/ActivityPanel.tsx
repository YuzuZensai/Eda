import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { stateLabel } from "@shared/i18n/labels";
import {
  ActivityIcon as Activity,
  ChevronUpIcon as ChevronUp,
  RefreshIcon as RefreshCw,
} from "../components/ui/icons";
import { useState } from "react";
import {
  CodeBlock,
  Collapse,
  Disclosure,
  ErrorDialog,
  ListItemButton,
  TextButton,
} from "../components/ui/index";
import { BackgroundFetchPanel } from "../features/sync/BackgroundFetchPanel";
import { useAppStore } from "../stores/app-store";
import { useRepositoryStore } from "../stores/repository-store";
import { useOperationRecords } from "../hooks/useOperationRecords";
import { formatDateTime } from "../utils/format";

export function ActivityPanel() {
  const repositories = useAppStore((state) => state.repositories);
  const selectedRepositoryId = useAppStore((state) => state.selectedRepositoryId);
  const { records, error: loadError } = useOperationRecords();
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const running = records.filter(
    (record) => record.state === "queued" || record.state === "running",
  );

  const active = running.length;
  const current =
    running.find((record) => record.repositoryId === selectedRepositoryId) ?? running[0];

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
    <section
      aria-label={t("activityPanel.activity")}
      data-layout-region=""
      className="app-surface-chrome shrink-0 border-t border-border-default bg-bg-inset"
    >
      <ListItemButton
        data-layout-region=""
        className="h-7 px-3 text-xs"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Activity size={13} className="shrink-0" />
        <span className="shrink-0">{t("activityPanel.activity")}</span>

        {active > 0 && (
          <span role="status" className="flex min-w-0 flex-1 items-center gap-3">
            <span className="shrink-0 text-accent-text">
              {t("activityPanel.running", { active: active })}
            </span>

            {current && (
              <span
                className="truncate text-text-secondary"
                title={`${current.repositoryName}, ${current.kind}: ${current.message}`}
              >
                {current.repositoryName}, {current.message}
              </span>
            )}
          </span>
        )}

        <ChevronUp
          size={13}
          aria-hidden="true"
          className="activity-chevron ml-auto shrink-0"
          data-open={open}
        />
      </ListItemButton>

      <Collapse className="activity-content" open={open}>
        <div className="flex h-full min-h-0 flex-col">
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

          <div className="min-h-0 flex-1 overflow-auto">
            {records.length === 0 && (
              <p className="p-4 text-sm text-text-tertiary">
                {t("activityPanel.gitOperationsWillAppearHere")}
              </p>
            )}

            {records.map((record) => (
              <Disclosure
                key={record.id}
                className="border-t border-border-subtle text-xs"
                summaryClassName="flex items-center gap-3 px-3 py-2"
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
                    {record.cancellable && (
                      <TextButton
                        disabled={busy === record.id}
                        tone="danger"
                        onClick={() => void run(record.id, "cancel")}
                      >
                        {t("common.cancelOperation")}
                      </TextButton>
                    )}

                    {record.retryable && (
                      <TextButton
                        disabled={busy === record.id}
                        tone="accent"
                        onClick={() => void run(record.id, "retry")}
                      >
                        {t("activityPanel.retryAgainstCurrentState")}
                      </TextButton>
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
                      <RefreshCw size={12} />
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
      </Collapse>
    </section>
  );
}
