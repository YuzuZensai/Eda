import { Localized } from "@renderer/i18n/Localized";
import { errorMessage } from "@shared/errors";
import { getLocale, t } from "@shared/i18n";
import { replayActionLabel } from "@shared/i18n/labels";
import type { ReplayAction, ReplayKind, ReplayReview } from "@shared/workflows/replay";
import { ArrowDownIcon as ArrowDown, ArrowUpIcon as ArrowUp } from "../../components/ui/icons";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorDialog,
  Input,
  ReviewActions,
  Select,
} from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";

interface ReplayDialogProps {
  repositoryId: string;
  kind: ReplayKind;
  action: ReplayAction;
  initialCommits?: string[];
  onClose: () => void;
}

export function ReplayDialog(props: ReplayDialogProps) {
  return (
    <ReplayDialogContent
      key={JSON.stringify([props.repositoryId, props.kind, props.action, props.initialCommits])}
      {...props}
    />
  );
}

function ReplayDialogContent({
  repositoryId,
  kind,
  action,
  initialCommits,
  onClose,
}: ReplayDialogProps) {
  const [oids, setOids] = useState<string[]>(initialCommits ?? []);
  const [input, setInput] = useState("");
  const [mainline, setMainline] = useState<number | undefined>();
  const [review, setReview] = useState<ReplayReview | null>(null);
  const [dirty, setDirty] = useState(true);
  const request = useRef(0);
  const [phase, setPhase] = useState<"prepare" | "execute" | null>(null);
  const busy = phase !== null;
  const [confirmed, setConfirmed] = useState(false);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pages = useRepositoryStore((state) => state.pages);

  const commits = [
    ...new Map(
      pages.flatMap((page) => page.commits).map((commit) => [commit.oid, commit]),
    ).values(),
  ];

  const title = replayActionLabel(kind, action);

  const change = (next: string[]) => {
    setOids(next);
    setDirty(true);
    setConfirmed(false);
  };

  const add = (oid: string) => {
    if (oid.trim() && !oids.includes(oid.trim())) change([...oids, oid.trim()]);
    setInput("");
  };

  const prepare = async () => {
    const generation = ++request.current;
    setPhase("prepare");
    setError(null);
    setReview(null);
    setDirty(true);
    setConfirmed(false);

    try {
      const result = await window.eda.replay.prepare(
        repositoryId,
        kind,
        action,
        action === "start" ? oids : [],
        mainline,
      );

      if (generation !== request.current) return;

      if (result.ok) {
        setReview(result.value);
        setDirty(false);
      } else {
        setError(errorMessage(result.error));
        setDirty(true);
      }
    } catch (error) {
      if (generation === request.current) setError(errorMessage(error));
    } finally {
      if (generation === request.current) setPhase(null);
    }
  };

  useEffect(() => {
    void prepare();

    return () => {
      request.current += 1;
    };
  }, [repositoryId, kind, action]);

  const execute = async () => {
    if (!review || dirty) return;

    const generation = request.current;

    setPhase("execute");
    setError(null);

    try {
      const result = await window.eda.replay.execute(repositoryId, review.token);

      if (generation !== request.current) return;
      if (useRepositoryStore.getState().repositoryId === repositoryId)
        await useRepositoryStore.getState().syncFromDisk();
      if (generation !== request.current) return;

      if (result.ok) {
        if (result.value.recoveryWarning) setRecoveryWarning(result.value.recoveryWarning);
        else onClose();
      } else {
        setError(errorMessage(result.error));
        setConfirmed(false);
        setDirty(true);
      }
    } catch (error) {
      if (generation === request.current) setError(errorMessage(error));
    } finally {
      if (generation === request.current) setPhase(null);
    }
  };

  const merges = review?.commits.filter((commit) => commit.parents.length > 1) ?? [];
  const needsMainline = action === "start" && merges.length > 0;

  return (
    <Dialog
      title={title}
      wide
      busy={busy}
      onClose={onClose}
      description={
        action === "start"
          ? kind === "cherry-pick"
            ? t("replayDialog.applyTheSelectedChangesAsNewCommitsOn")
            : t("replayDialog.createNewCommitsThatReverseTheSelectedChanges")
          : action === "abort"
            ? t("replayDialog.returnToTheStateBeforeThisOperationRecovery")
            : action === "skip"
              ? t("replayDialog.discardTheCurrentReplayAndItsResolutionThen")
              : t("replayDialog.commitTheStagedResolutionAndContinueTheRemainingSelection")
      }
      footer={
        <ReviewActions
          preparing={phase === "prepare"}
          busy={busy}
          onClose={onClose}
          onReview={() => void prepare()}
          onConfirm={() => void execute()}
          confirmLabel={title}
          confirmDisabled={
            !!recoveryWarning ||
            dirty ||
            !review ||
            !confirmed ||
            (needsMainline && review.mainline === undefined)
          }
          confirmVariant="secondary"
          closeLabel={recoveryWarning ? t("common.close") : t("common.cancel")}
          closeVariant="secondary"
          reviewDisabled={!!recoveryWarning}
        />
      }
    >
      <div className="space-y-3 text-xs">
        {recoveryWarning && <p role="status">{recoveryWarning}</p>}

        {action === "start" && (
          <>
            <p>{t("replayDialog.executionOrderTopToBottomAddUpTo100")}</p>

            <Select
              aria-label={t("replayDialog.addCommitFromLoadedHistory")}
              value=""
              disabled={busy || oids.length >= 100}
              surface="surface"
              className="w-full"
              onValueChange={(value) => add(value)}
            >
              <option value="">{t("replayDialog.addACommitFromLoadedHistory")}</option>

              {commits
                .filter((commit) => !oids.includes(commit.oid))
                .map((commit) => (
                  <option key={commit.oid} value={commit.oid}>
                    {commit.oid.slice(0, 8)}, {commit.subject}
                  </option>
                ))}
            </Select>

            <div className="flex gap-2">
              <Input
                aria-label={t("replayDialog.commitIdToAdd")}
                value={input}
                disabled={busy || oids.length >= 100}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t("replayDialog.orPasteAFullCommitId")}
              />

              <Button
                size="sm"
                disabled={busy || !input.trim() || oids.length >= 100}
                onClick={() => add(input)}
              >
                {t("replayDialog.addCommit")}
              </Button>
            </div>

            <ol className="max-h-56 overflow-auto space-y-2">
              {oids.map((oid, index) => (
                <li
                  key={oid}
                  className="flex items-center gap-2 rounded border border-border-default p-2"
                >
                  <span>{index + 1}.</span>
                  <code title={oid}>{oid.slice(0, 8)}</code>

                  <span className="min-w-0 flex-1 truncate">
                    {review?.commits.find((commit) => commit.oid === oid)?.subject ??
                      commits.find((commit) => commit.oid === oid)?.subject}
                  </span>

                  {[-1, 1].map((direction) => (
                    <Button
                      key={direction}
                      size="sm"
                      disabled={busy || index + direction < 0 || index + direction >= oids.length}
                      aria-label={t("replayDialog.move", {
                        oid: oid.slice(0, 8),
                        value2: direction < 0 ? t("replayDialog.up") : t("replayDialog.down"),
                      })}
                      onClick={() => {
                        const next = [...oids];

                        [next[index], next[index + direction]] = [
                          next[index + direction]!,
                          next[index]!,
                        ];

                        change(next);
                      }}
                    >
                      {direction < 0 ? (
                        <ArrowUp size={14} aria-hidden="true" />
                      ) : (
                        <ArrowDown size={14} aria-hidden="true" />
                      )}
                    </Button>
                  ))}

                  <Button
                    size="sm"
                    disabled={busy}
                    aria-label={t("replayDialog.remove", { oid: oid.slice(0, 8) })}
                    onClick={() => change(oids.filter((item) => item !== oid))}
                  >
                    {t("common.remove")}
                  </Button>
                </li>
              ))}
            </ol>

            {needsMainline && (
              <>
                <label className="flex gap-2 items-center">
                  {t("replayDialog.mainlineParentForEverySelectedMerge")}

                  <Select
                    aria-label={t("replayDialog.mainlineParent")}
                    value={mainline ?? ""}
                    disabled={busy}
                    surface="surface"
                    onValueChange={(value) => {
                      setMainline(value ? Number(value) : undefined);
                      setDirty(true);
                      setConfirmed(false);
                    }}
                  >
                    <option value="">{t("replayDialog.chooseExplicitly")}</option>

                    {Array.from(
                      { length: Math.min(...merges.map((commit) => commit.parents.length)) },
                      (_, index) => (
                        <option key={index} value={index + 1}>
                          {t("replayDialog.parent", { value1: index + 1 })}
                        </option>
                      ),
                    )}
                  </Select>
                </label>

                <p>{t("replayDialog.theChangeIsComputedRelativeToThatParent")}</p>

                {merges.map((commit) => (
                  <div key={commit.oid}>
                    <p>{commit.subject}</p>

                    <ol className="font-mono">
                      {commit.parents.map((parent, index) => (
                        <li key={parent}>
                          {index + 1}: {parent}
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {review && (
          <>
            <p>
              <Localized
                id="replayDialog.destination"
                values={{
                  value1: review.branch ?? t("replayDialog.detachedHead"),
                  code2: <code>{review.head}</code>,
                }}
              />
            </p>

            <p>
              {t("replayDialog.committerDetails", { author: review.author, email: review.email })}
            </p>

            {(action === "abort" || action === "skip") && (
              <>
                <p>
                  {t("replayDialog.recoveryWillPreservePathsBytes", {
                    length: review.paths.length,
                    recoveryBytes: review.recoveryBytes.toLocaleString(getLocale()),
                  })}
                </p>

                <ul className="max-h-36 overflow-auto font-mono">
                  {review.paths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </>
            )}

            {dirty && (
              <p className="text-git-modified">
                {t("replayDialog.reviewTheChangedSelectionBeforeConfirming")}
              </p>
            )}

            <Checkbox
              disabled={busy || dirty}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            >
              {t("replayDialog.iReviewedThisAction", { kind: kind })}
            </Checkbox>
          </>
        )}

        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
