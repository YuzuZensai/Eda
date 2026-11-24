import { errorMessage } from "@shared/errors";
import { t, type MessageKey } from "@shared/i18n";
import {
  RECOVERY_PAGE_SIZE,
  type RecoveryInspection,
  type RecoveryPage,
  type RecoverySource,
} from "@shared/workflows/history-recovery";
import { useEffect, useState } from "react";
import { formatDateTime } from "../../utils/format";

import {
  Button,
  Checkbox,
  Dialog,
  Disclosure,
  ErrorDialog,
  Input,
  ListItemButton,
  StateMessage,
} from "../../components/ui/index";
import { RefreshIcon } from "../../components/ui/icons";
import { boundDiff } from "../../repository/diff-model";
import { useRepositoryStore } from "../../stores/repository-store";
import { DiffContent } from "../diff/DiffContent";

const sources = ["reflog", "saved", "unreachable", "rewrites"] as const;
const sourceLabels = {
  reflog: "recovery.reflogs",
  saved: "recovery.saved",
  unreachable: "recovery.scan",
  rewrites: "recovery.rewrites",
  dangling: "dangling.title",
} satisfies Record<RecoverySource, MessageKey>;

export function HistoryRecoveryDialog({
  repositoryId,
  onClose,
  dangling = false,
}: {
  repositoryId: string;
  dangling?: boolean;
  onClose: () => void;
}) {
  const [source, setSource] = useState<RecoverySource>("reflog");
  const [page, setPage] = useState<RecoveryPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [oid, setOid] = useState("");
  const [inspection, setInspection] = useState<RecoveryInspection | null>(null);
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);

  const load = async (nextSource: RecoverySource, nextOffset = 0) => {
    setBusy(true);
    setError(null);
    setPage(null);
    setInspection(null);
    setConfirmed(false);
    setCleanupConfirmed(false);
    setSource(nextSource);
    setOffset(nextOffset);
    setOid("");
    setRestored(null);

    try {
      const result = await window.eda.historyRecovery.list(repositoryId, nextSource, nextOffset);
      if (result.ok) setPage(result.value);
      else setError(errorMessage(result.error));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load(dangling ? "dangling" : "reflog");
  }, [repositoryId, dangling]);

  const inspect = async (commit: string) => {
    setBusy(true);
    setError(null);
    setInspection(null);
    setConfirmed(false);
    setRestored(null);
    setOid(commit);

    try {
      const result = await window.eda.historyRecovery.inspect(repositoryId, commit);
      if (result.ok) setInspection({ ...result.value, diff: boundDiff(result.value.diff) });
      else setError(errorMessage(result.error));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!inspection) return;

    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.historyRecovery.restore(
        repositoryId,
        inspection.token,
        name.trim(),
      );

      if (result.ok) {
        if (dangling) await load("dangling");
        setRestored(result.value);
        setInspection(null);
        setConfirmed(false);
        if (useRepositoryStore.getState().repositoryId === repositoryId)
          await useRepositoryStore.getState().syncFromDisk();
      } else setError(errorMessage(result.error));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const clearDangling = async () => {
    if (!cleanupConfirmed || !page?.cleanup || busy) return;
    setBusy(true);
    setError(null);
    setCleanupConfirmed(false);

    try {
      const result = await window.eda.historyRecovery.clearDangling(
        repositoryId,
        page.cleanup.token,
      );
      if (result.ok) await load("dangling");
      else setError(errorMessage(result.error));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const matches = page?.entries.filter((entry) =>
    `${entry.oid} ${entry.label} ${entry.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const retry = (
    <Button
      size="sm"
      variant="ghost"
      icon={<RefreshIcon size={14} />}
      disabled={busy}
      onClick={() => void load(source)}
    >
      {t("common.refresh")}
    </Button>
  );

  return (
    <Dialog
      title={
        cleanupConfirmed
          ? t("dangling.clear", { count: page?.cleanup?.count ?? 0 })
          : t(dangling ? "dangling.title" : "recovery.title")
      }
      {...(dangling && !cleanupConfirmed && { description: t("dangling.description") })}
      wide={!dangling}
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {dangling && inspection && !cleanupConfirmed && (
            <Button variant="ghost" disabled={busy} onClick={() => setInspection(null)}>
              {t("common.back")}
            </Button>
          )}
          {dangling && !!page?.cleanup?.count && !inspection && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => (cleanupConfirmed ? void clearDangling() : setCleanupConfirmed(true))}
            >
              {t("dangling.clear", { count: page.cleanup.count })}
            </Button>
          )}
          <Button
            disabled={busy}
            onClick={cleanupConfirmed ? () => setCleanupConfirmed(false) : onClose}
          >
            {t(cleanupConfirmed ? "common.cancel" : "common.close")}
          </Button>
        </>
      }
    >
      {cleanupConfirmed ? (
        <p className="text-sm leading-relaxed text-text-secondary">{t("dangling.confirm")}</p>
      ) : (
        <div className="space-y-3 text-xs">
          {!dangling && (
            <>
              <p>{t("recovery.description")}</p>
              <div className="flex flex-wrap gap-2">
                {sources.map((value) => (
                  <Button
                    key={value}
                    aria-pressed={source === value}
                    variant={source === value ? "primary" : "secondary"}
                    disabled={busy}
                    onClick={() => void load(value)}
                  >
                    {t(sourceLabels[value])}
                  </Button>
                ))}
              </div>
            </>
          )}

          {source === "rewrites" && <p role="note">{t("recovery.rewritesHelp")}</p>}

          <div
            className={
              dangling
                ? "space-y-3"
                : "grid items-start gap-4 md:grid-cols-[minmax(16rem,2fr)_minmax(0,3fr)]"
            }
          >
            {(!dangling || !inspection) && (
              <div className="min-w-0 space-y-3" aria-busy={busy}>
                {!page ? (
                  <StateMessage
                    tone={error ? "error" : "loading"}
                    title={error ?? t("recovery.loading")}
                    action={error ? retry : undefined}
                  />
                ) : !page.entries.length ? (
                  <StateMessage
                    title={t(dangling ? "dangling.empty" : "recovery.empty")}
                    action={retry}
                  />
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={t("recovery.filterLabel")}
                        placeholder={t("recovery.filter")}
                        value={query}
                        disabled={busy}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                      {dangling && retry}
                    </div>
                    <p className="text-text-tertiary">
                      {dangling
                        ? t("dangling.count", { count: page.cleanup?.count ?? 0 })
                        : t("recovery.range", {
                            value1: t(
                              source === "unreachable"
                                ? "recovery.unreachable"
                                : sourceLabels[source],
                            ),
                            value2: offset + 1,
                            value3: offset + page.entries.length,
                          })}
                    </p>
                    <div className="max-h-80 overflow-auto divide-y divide-border-subtle border-y border-border-subtle">
                      {matches?.map((entry, index) => (
                        <ListItemButton
                          key={`${entry.label}:${entry.oid}:${index}`}
                          selected={inspection?.inspection.commit.oid === entry.oid}
                          aria-pressed={inspection?.inspection.commit.oid === entry.oid}
                          disabled={busy}
                          onClick={() => void inspect(entry.oid)}
                          className="flex-col py-2.5"
                          aria-label={t("recovery.inspect", { oid: entry.oid, label: entry.label })}
                        >
                          <span className="flex w-full items-center gap-3">
                            <span className="min-w-0 flex-1 truncate text-text-primary">
                              {entry.label}
                            </span>
                            <span className="shrink-0 font-mono text-xs text-text-tertiary">
                              {entry.oid.slice(0, 8)}
                            </span>
                          </span>
                          {entry.description && (
                            <p
                              className={`w-full ${source === "rewrites" ? "break-all" : "truncate"} text-text-secondary`}
                            >
                              {entry.description}
                            </p>
                          )}
                        </ListItemButton>
                      ))}
                      {!matches?.length && <StateMessage title={t("historySearch.noMatches")} />}
                    </div>
                    {(offset > 0 || page.nextOffset !== null) && (
                      <div className="flex justify-between gap-2">
                        <Button
                          size="sm"
                          disabled={busy || offset === 0}
                          onClick={() =>
                            void load(source, Math.max(0, offset - RECOVERY_PAGE_SIZE))
                          }
                        >
                          {t("recovery.previous")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy || page.nextOffset === null}
                          onClick={() => void load(source, page.nextOffset!)}
                        >
                          {t("recovery.next")}
                        </Button>
                      </div>
                    )}
                  </>
                )}
                {!dangling && (
                  <div className="flex gap-2">
                    <Input
                      aria-label={t("recovery.commitId")}
                      value={oid}
                      onChange={(event) => setOid(event.target.value)}
                      mono
                      placeholder={t("recovery.oid")}
                    />
                    <Button disabled={busy || !oid.trim()} onClick={() => void inspect(oid.trim())}>
                      {t("recovery.inspectButton")}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {(!dangling || inspection) && (
              <div
                className={
                  dangling
                    ? "min-w-0 space-y-3"
                    : "min-w-0 space-y-3 rounded-md border border-border-subtle p-3"
                }
              >
                {!inspection && <p>{t("recovery.select")}</p>}
                {inspection && (
                  <section className="space-y-3">
                    <h3 className="text-sm font-semibold">
                      {inspection.inspection.commit.subject}
                    </h3>
                    <p className="break-all font-mono text-text-tertiary">
                      {inspection.inspection.commit.oid}
                    </p>
                    <p className="text-text-secondary">
                      {t("recovery.author", {
                        name: inspection.inspection.commit.author.name,
                        email: inspection.inspection.commit.author.email,
                        value3: formatDateTime(inspection.inspection.commit.author.timestamp),
                      })}
                    </p>
                    {inspection.inspection.commit.body && (
                      <p className="whitespace-pre-wrap">{inspection.inspection.commit.body}</p>
                    )}
                    {!dangling && (
                      <>
                        <p className="break-all">
                          {t("recovery.parents", {
                            value1:
                              inspection.inspection.commit.parents.join(", ") || t("recovery.root"),
                          })}
                        </p>
                        <p className="break-all">
                          {t("recovery.refs", {
                            value1:
                              inspection.inspection.containingRefs.join(", ") || t("recovery.none"),
                          })}
                        </p>
                        <p>{t("recovery.diffHelp")}</p>
                      </>
                    )}
                    {inspection.inspection.shallow && <p>{t("recovery.shallow")}</p>}
                    {inspection.diffNotice && <p>{inspection.diffNotice}</p>}
                    {!!inspection.diff.files.length && (
                      <div className="flex h-64 min-h-0 flex-col overflow-hidden rounded-md border border-border-default">
                        <DiffContent
                          key={inspection.inspection.commit.oid}
                          diff={inspection.diff}
                          mode="unified"
                          readOnly
                        />
                      </div>
                    )}
                    <Disclosure title={t("repositoryCommands.createBranch")} open={!dangling}>
                      <div className="space-y-3 pt-3">
                        <Input
                          aria-label={t("recovery.branch")}
                          placeholder={t("recovery.newBranchName")}
                          value={name}
                          disabled={busy}
                          onChange={(event) => {
                            setName(event.target.value);
                            setConfirmed(false);
                          }}
                        />
                        <Checkbox
                          className="flex gap-2"
                          disabled={busy}
                          checked={confirmed}
                          onChange={(event) => setConfirmed(event.target.checked)}
                        >
                          {t("recovery.confirm")}
                        </Checkbox>
                        <Button
                          disabled={busy || !confirmed || !name.trim()}
                          onClick={() => void restore()}
                        >
                          {t("recovery.restore")}
                        </Button>
                      </div>
                    </Disclosure>
                  </section>
                )}
              </div>
            )}
          </div>
          {restored && <p role="status">{t("recovery.restored", { restored })}</p>}
          {!dangling && (
            <Disclosure title={t("recovery.about")}>
              <p className="text-text-tertiary">{t("recovery.sourcesHelp")}</p>
            </Disclosure>
          )}
          {page && <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>}
        </div>
      )}
    </Dialog>
  );
}
