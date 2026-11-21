import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
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
  Field,
  Input,
  ListItemButton,
} from "../../components/ui/index";
import { boundDiff } from "../../repository/diff-model";
import { useRepositoryStore } from "../../stores/repository-store";
import { DiffContent } from "../diff/DiffContent";

export function HistoryRecoveryDialog({
  repositoryId,
  onClose,
}: {
  repositoryId: string;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);

  const load = async (nextSource: RecoverySource, nextOffset = 0) => {
    setBusy(true);
    setError(null);
    setPage(null);
    setInspection(null);
    setConfirmed(false);
    setSource(nextSource);
    setOffset(nextOffset);
    setOid("");
    setRestored(null);

    try {
      const result = await window.eda.historyRecovery.list(repositoryId, nextSource, nextOffset);
      if (result.ok) setPage(result.value);
      else setError(errorMessage(result.error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load("reflog");
  }, [repositoryId]);

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
        setRestored(result.value);
        setInspection(null);
        setConfirmed(false);
        if (useRepositoryStore.getState().repositoryId === repositoryId)
          await useRepositoryStore.getState().syncFromDisk();
      } else setError(errorMessage(result.error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("historyRecoveryDialog.reflogAndHistoryRecovery")}
      wide
      busy={busy}
      onClose={onClose}
      footer={
        <Button disabled={busy} onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      <div className="space-y-3 text-xs">
        <p>{t("historyRecoveryDialog.inspectACommitThenCreateABranchTo")}</p>

        <div className="flex flex-wrap gap-2">
          <Button
            aria-pressed={source === "reflog"}
            variant={source === "reflog" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void load("reflog")}
          >
            {t("historyRecoveryDialog.reflogs")}
          </Button>
          <Button
            aria-pressed={source === "saved"}
            variant={source === "saved" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void load("saved")}
          >
            {t("historyRecoveryDialog.savedRecoveryRefs")}
          </Button>
          <Button
            aria-pressed={source === "unreachable"}
            variant={source === "unreachable" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void load("unreachable")}
          >
            {t("historyRecoveryDialog.scanUnreachableCommits")}
          </Button>
          <Button
            aria-pressed={source === "rewrites"}
            variant={source === "rewrites" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void load("rewrites")}
          >
            {t("historyRecoveryDialog.sharedHistoryActions")}
          </Button>
        </div>

        {source === "rewrites" && (
          <p role="note">
            {t("historyRecoveryDialog.recordedActionsThatAffectedLocallyKnownPublishedHistory")}
          </p>
        )}

        <div className="grid items-start gap-4 md:grid-cols-[minmax(16rem,2fr)_minmax(0,3fr)]">
          <div className="min-w-0 space-y-3">
            <Field label={t("historyRecoveryDialog.filterThisPage")}>
              {(props) => (
                <Input
                  {...props}
                  aria-label={t("historyRecoveryDialog.filterRecoveryEntries")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              )}
            </Field>

            {busy && <p role="status">{t("historyRecoveryDialog.readingRepository")}</p>}

            {page && (
              <>
                <p>
                  {t("historyRecoveryDialog.entriesTo", {
                    value1:
                      source === "reflog"
                        ? t("historyRecoveryDialog.reflogs")
                        : source === "saved"
                          ? t("historyRecoveryDialog.savedRecoveryRefs")
                          : source === "rewrites"
                            ? t("historyRecoveryDialog.sharedHistoryActions")
                            : t("historyRecoveryDialog.unreachableCommits"),
                    value2: page.entries.length ? offset + 1 : 0,
                    value3: offset + page.entries.length,
                  })}
                </p>

                <div className="max-h-48 overflow-auto border-y border-border-subtle">
                  {page.entries
                    .filter((entry) =>
                      `${entry.oid} ${entry.label} ${entry.description}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((entry, index) => (
                      <ListItemButton
                        key={`${entry.label}:${entry.oid}:${index}`}
                        selected={inspection?.inspection.commit.oid === entry.oid}
                        aria-pressed={inspection?.inspection.commit.oid === entry.oid}
                        disabled={busy}
                        onClick={() => void inspect(entry.oid)}
                        className="block border-b border-border-subtle p-2"
                        aria-label={t("historyRecoveryDialog.inspect", {
                          oid: entry.oid,
                          label: entry.label,
                        })}
                      >
                        <span className="font-mono text-accent-text">{entry.oid.slice(0, 12)}</span>{" "}
                        , {entry.label}
                        <p
                          className={`${source === "rewrites" ? "break-all" : "truncate"} text-text-secondary`}
                        >
                          {entry.description}
                        </p>
                      </ListItemButton>
                    ))}
                </div>

                {!page.entries.length && (
                  <p>{t("historyRecoveryDialog.noEntriesAvailableInThisSource")}</p>
                )}

                <div className="flex gap-2">
                  <Button
                    disabled={busy || offset === 0}
                    onClick={() => void load(source, Math.max(0, offset - RECOVERY_PAGE_SIZE))}
                  >
                    {t("historyRecoveryDialog.previousPage")}
                  </Button>

                  <Button
                    disabled={busy || page.nextOffset === null}
                    onClick={() => void load(source, page.nextOffset!)}
                  >
                    {t("historyRecoveryDialog.nextPage")}
                  </Button>
                </div>
              </>
            )}

            <div className="flex gap-2">
              <Input
                aria-label={t("historyRecoveryDialog.commitIdToInspect")}
                value={oid}
                onChange={(event) => setOid(event.target.value)}
                mono
                placeholder={t("historyRecoveryDialog.fullCommitId")}
              />

              <Button disabled={busy || !oid.trim()} onClick={() => void inspect(oid.trim())}>
                {t("historyRecoveryDialog.inspectCommit")}
              </Button>
            </div>
          </div>
          <div className="min-w-0 space-y-3 rounded-md border border-border-subtle p-3">
            {!inspection && <p>{t("historyRecoveryDialog.selectEntry")}</p>}
            {inspection && (
              <section className="space-y-2">
                <h3 className="font-semibold">{inspection.inspection.commit.subject}</h3>
                <p className="break-all font-mono">{inspection.inspection.commit.oid}</p>

                <p>
                  {t("historyRecoveryDialog.authorDetails", {
                    name: inspection.inspection.commit.author.name,
                    email: inspection.inspection.commit.author.email,
                    value3: formatDateTime(inspection.inspection.commit.author.timestamp),
                  })}
                </p>

                <p className="whitespace-pre-wrap">{inspection.inspection.commit.body}</p>

                <p className="break-all">
                  {t("historyRecoveryDialog.parents", {
                    value1:
                      inspection.inspection.commit.parents.join(", ") ||
                      t("historyRecoveryDialog.rootCommit"),
                  })}
                </p>

                <p className="break-all">
                  {t("historyRecoveryDialog.containingBranchesTags", {
                    value1:
                      inspection.inspection.containingRefs.join(", ") ||
                      t("historyRecoveryDialog.none"),
                  })}
                </p>

                {inspection.inspection.shallow && (
                  <p>{t("historyRecoveryDialog.shallowRepositoryLocalAncestryMayBeIncomplete")}</p>
                )}
                <p>
                  {t(
                    "historyRecoveryDialog.changesRelativeToTheFirstParentEmptyTreeForARootCommit",
                  )}
                </p>
                {inspection.diffNotice && <p>{inspection.diffNotice}</p>}

                <div className="flex h-64 min-h-0 flex-col overflow-hidden border border-border-default">
                  <DiffContent
                    key={inspection.inspection.commit.oid}
                    diff={inspection.diff}
                    mode="unified"
                    readOnly
                  />
                </div>

                <label className="block">
                  {t("historyRecoveryDialog.newBranchName")}

                  <Input
                    aria-label={t("historyRecoveryDialog.recoveredBranchName")}
                    value={name}
                    disabled={busy}
                    onChange={(event) => {
                      setName(event.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>

                <Checkbox
                  className="flex gap-2"
                  disabled={busy}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                >
                  {t("historyRecoveryDialog.createThisBranchAtTheInspectedCommit")}
                </Checkbox>

                <Button
                  disabled={busy || !confirmed || !name.trim()}
                  onClick={() => void restore()}
                >
                  {t("historyRecoveryDialog.restoreAsBranch")}
                </Button>
              </section>
            )}

            {restored && (
              <p role="status">
                {t("historyRecoveryDialog.restoredTheCurrentCheckoutIsUnchanged", {
                  restored: restored,
                })}
              </p>
            )}
          </div>
        </div>
        <Disclosure title={t("historyRecoveryDialog.aboutSources")}>
          {" "}
          <p className="text-text-tertiary">
            {t("historyRecoveryDialog.reflogsIncludeLocalRefUpdatesAndCheckoutHistory")}
          </p>
        </Disclosure>
        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
