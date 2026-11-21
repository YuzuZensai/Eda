import { errorText } from "@shared/error-codes";
import { errorMessage, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  CherryIcon as Cherry,
  CopyIcon as Copy,
  DiffIcon,
  FolderGit2Icon,
  DownloadIcon,
  PencilIcon,
  BranchIcon as GitBranch,
  GitCommitHorizontalIcon as GitCommitHorizontal,
  GitMergeIcon as GitMerge,
  LinkIcon as Link,
  RotateCcwIcon as RotateCcw,
  TagIcon as Tag,
  Undo2Icon as Undo2,
} from "../../components/ui/icons";
import { useRef, useState } from "react";
import {
  captureRepositoryCommand,
  repositoryCommandDispatcher,
  repositoryCommandReason,
} from "../../commands/repository-commands";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorDialog,
  Input,
  MenuItem,
  ContextPopover,
  Textarea,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { copyText } from "../../utils/clipboard";
import { MergeStartDialog } from "../workflows/MergeStartDialog";
import { WorktreesDialog } from "../repositories/WorktreesDialog";
import { RebaseDialog } from "../workflows/RebaseDialog";
import { ReplayDialog } from "../workflows/ReplayDialog";
import { ResetDialog } from "../workflows/ResetDialog";

export interface CommitMenuTarget {
  oid: string;
  x: number;
  y: number;
}

export function CommitMenu({
  target,
  onClose,
  initialMode = "menu",
}: {
  target: CommitMenuTarget;
  onClose: () => void;
  initialMode?: "menu" | "tag" | "branch";
}) {
  const repositoryId = useAppStore((state) => state.selectedRepositoryId);
  const repository = useAppStore((state) =>
    state.repositories.find((repo) => repo.id === repositoryId),
  );
  const status = useRepositoryStore((state) => state.status);
  const commandContext = captureRepositoryCommand(repositoryId ?? "");
  const dispatch = repositoryCommandDispatcher(commandContext);
  const commandUnavailable = repositoryCommandReason(commandContext);
  const refresh = useRepositoryStore((state) => state.refresh);
  const selection = useRepositoryStore((state) => state.selection);
  const compareFrom =
    selection?.kind === "commit" && selection.oid !== target.oid ? selection.oid : "";

  const commits = useRepositoryStore((state) => state.pages).flatMap((page) => page.commits);
  const first = commits.findIndex((c) => c.oid === compareFrom);
  const last = commits.findIndex((c) => c.oid === target.oid);
  const [range, setRange] = useState<typeof commits>([]);
  const [mode, setMode] = useState<
    | "menu"
    | "tag"
    | "branch"
    | "merge"
    | "cherry-pick"
    | "revert"
    | "reset"
    | "range"
    | "reword"
    | "worktree"
  >(initialMode);

  const [name, setName] = useState("");
  const [sign, setSign] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);

  if (!repositoryId) return null;
  if (mode === "reword")
    return (
      <RebaseDialog
        repositoryId={repositoryId}
        action="reword"
        onto={target.oid}
        onClose={onClose}
      />
    );
  if (mode === "worktree" && repository)
    return <WorktreesDialog repository={repository} startCommit={target.oid} onClose={onClose} />;
  if (mode === "reset")
    return <ResetDialog repositoryId={repositoryId} target={target.oid} onClose={onClose} />;

  if (mode === "cherry-pick" || mode === "revert")
    return (
      <ReplayDialog
        repositoryId={repositoryId}
        kind={mode}
        action="start"
        initialCommits={
          range.length
            ? (mode === "revert" ? range : [...range].reverse()).map((c) => c.oid)
            : [target.oid]
        }
        onClose={onClose}
      />
    );

  if (mode === "range") {
    const oldest = range.at(-1);
    const parent = oldest?.parents[0];
    const linear = range.every(
      (c, i) =>
        i === range.length - 1 || (c.parents.length === 1 && c.parents[0] === range[i + 1]?.oid),
    );
    return (
      <Dialog
        title={t("range.inspect", { count: range.length })}
        onClose={onClose}
        footer={
          <>
            {linear && parent && (
              <Button
                onClick={() => {
                  onClose();
                  useRepositoryStore.getState().compareRevisions(parent, range[0]!.oid);
                }}
              >
                {t("comparison.title")}
              </Button>
            )}
            <Button
              disabled={!!commandUnavailable || range.length > 100}
              onClick={() => setMode("cherry-pick")}
            >
              {t("commitMenu.cherryPick")}
            </Button>
            <Button
              disabled={!!commandUnavailable || range.length > 100}
              onClick={() => setMode("revert")}
            >
              {t("commitMenu.revert")}
            </Button>
          </>
        }
      >
        {range.length > 100 && <p>{t("range.limit")}</p>}
        <ol className="divide-y divide-border-subtle">
          {range.map((c) => (
            <li key={c.oid} className="flex gap-3 py-1">
              <span className="mono">{c.oid.slice(0, 8)}</span>
              {c.subject}
            </li>
          ))}
        </ol>
      </Dialog>
    );
  }

  if (mode === "merge")
    return <MergeStartDialog repositoryId={repositoryId} source={target.oid} onClose={onClose} />;

  const run = async (work: () => Promise<Result<unknown>>) => {
    if (submitting.current) return;

    if (commandUnavailable) {
      setError(commandUnavailable);
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError(null);

    try {
      const result = await work();

      if (!result.ok) {
        setError(errorMessage(result.error, errorText("commitMenu.thatDidNotWork")));
        return;
      }

      await refresh();
      onClose();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const canCreate =
    !busy && !commandUnavailable && !!name.trim() && !(mode === "tag" && sign && !message.trim());

  const createReference = () => {
    if (!canCreate) return;

    void run(() =>
      mode === "tag"
        ? dispatch("createTag", {
            repositoryId,
            name: name.trim(),
            target: target.oid,
            ...(message.trim() ? { message } : {}),
            sign,
          })
        : dispatch("createBranch", {
            repositoryId,
            name: name.trim(),
            startPoint: target.oid,
            checkout: true,
          }),
    );
  };

  return (
    <ContextPopover
      role={mode === "menu" ? "menu" : "dialog"}
      onClose={onClose}
      aria-label={
        mode === "menu" ? t("commitMenu.commitActions") : t("commitMenu.create", { mode: mode })
      }
      position={target}
      className="w-56"
    >
      <p className="mono truncate px-2 py-1 text-xs text-text-tertiary">
        {target.oid.slice(0, 10)}
      </p>

      {mode === "menu" && (
        <>
          <MenuItem
            disabled={!!commandUnavailable || !!status?.workflow || !!status?.branch.detached}
            onClick={() => setMode("reword")}
          >
            <PencilIcon size={13} aria-hidden="true" />
            {t("commitMenu.editMessage")}
          </MenuItem>

          <MenuItem
            onClick={() => {
              onClose();
              useRepositoryStore.getState().compareRevisions(compareFrom, target.oid);
            }}
          >
            <DiffIcon size={13} aria-hidden="true" />
            {compareFrom ? t("comparison.withSelected") : t("comparison.title")}
          </MenuItem>

          {first >= 0 && last >= 0 && (
            <MenuItem
              onClick={() => {
                setRange(commits.slice(Math.min(first, last), Math.max(first, last) + 1));
                setMode("range");
              }}
            >
              {t("range.select")}
            </MenuItem>
          )}

          <hr className="my-1 border-border-subtle" />

          <MenuItem
            disabled={busy || !!commandUnavailable}
            onClick={() =>
              void run(() => dispatch("checkoutBranch", { repositoryId, name: target.oid }))
            }
          >
            <GitCommitHorizontal size={13} className="shrink-0" aria-hidden="true" />
            {t("commitMenu.checkOutThisCommit")}
          </MenuItem>

          <MenuItem onClick={() => setMode("branch")}>
            <GitBranch size={13} className="shrink-0" aria-hidden="true" />
            {t("commitMenu.createBranchHere")}
          </MenuItem>

          <MenuItem onClick={() => setMode("tag")}>
            <Tag size={13} className="shrink-0" aria-hidden="true" />
            {t("commitMenu.createTagHere")}
          </MenuItem>

          {repository && (
            <MenuItem disabled={!!commandUnavailable} onClick={() => setMode("worktree")}>
              <FolderGit2Icon size={13} aria-hidden="true" />
              {t("commitMenu.worktreeHere")}
            </MenuItem>
          )}

          <hr className="my-1 border-border-subtle" />

          {status?.branch.oid !== target.oid && (
            <MenuItem disabled={!!commandUnavailable} onClick={() => setMode("merge")}>
              <GitMerge size={13} className="shrink-0" aria-hidden="true" />
              {t("commitMenu.mergeIntoCurrentBranch")}
            </MenuItem>
          )}

          {status?.branch.oid !== target.oid && (
            <MenuItem disabled={!!commandUnavailable} onClick={() => setMode("cherry-pick")}>
              <Cherry size={13} className="shrink-0" aria-hidden="true" />
              {t("commitMenu.cherryPick")}
            </MenuItem>
          )}

          <MenuItem disabled={!!commandUnavailable} onClick={() => setMode("revert")}>
            <Undo2 size={13} className="shrink-0" aria-hidden="true" />
            {t("commitMenu.revert")}
          </MenuItem>

          <MenuItem disabled={!!commandUnavailable} onClick={() => setMode("reset")}>
            <RotateCcw size={13} className="shrink-0" aria-hidden="true" />
            {t("commitMenu.resetCurrentBranchHere")}
          </MenuItem>

          <hr className="my-1 border-border-subtle" />

          <MenuItem
            disabled={busy}
            onClick={async () => {
              if (submitting.current) return;
              submitting.current = true;
              setBusy(true);
              try {
                const result = await window.eda.repository.exportPatch({
                  repositoryId,
                  oid: target.oid,
                });
                if (result.ok) onClose();
                else setError(errorMessage(result.error));
              } catch (failure) {
                setError(errorMessage(failure));
              } finally {
                submitting.current = false;
                setBusy(false);
              }
            }}
          >
            <DownloadIcon size={13} aria-hidden="true" />
            {t("patch.commit")}
          </MenuItem>

          <MenuItem
            onClick={() =>
              void copyText(target.oid)
                .then(onClose)
                .catch(() => setError(t("commitMenu.theCommitIdCouldNotBeCopied")))
            }
          >
            <Copy size={13} className="shrink-0" aria-hidden="true" />
            {t("commitMenu.copyCommitSha")}
          </MenuItem>

          <MenuItem
            onClick={async () => {
              const result = await window.eda.repository.referenceUrl(
                repositoryId,
                "commit",
                target.oid,
              );

              if (!result.ok) setError(errorMessage(result.error));
              else if (!result.value)
                setError(t("commitMenu.noSupportedBrowserUrlIsAvailableForTheDefaultRemote"));
              else
                await copyText(result.value)
                  .then(onClose)
                  .catch(() => setError(t("commitMenu.theUrlCouldNotBeCopied")));
            }}
          >
            <Link size={13} className="shrink-0" aria-hidden="true" />
            {t("commitMenu.copyCommitBrowserUrl")}
          </MenuItem>
        </>
      )}

      {mode !== "menu" && (
        <div className="p-1">
          <Input
            size="sm"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;

              event.preventDefault();
              createReference();
            }}
            placeholder={
              mode === "tag"
                ? t("commitMenu.tagNameThenEnter")
                : t("commitMenu.branchNameThenEnter")
            }
            aria-label={mode === "tag" ? t("commitMenu.tagName") : t("commitMenu.branchName")}
          />

          {mode === "tag" && (
            <Textarea
              aria-label={t("commitMenu.annotatedTagMessage")}
              placeholder={t("commitMenu.optionalAnnotationEmptyCreatesALightweightTag")}
              className="mt-2 text-xs"
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          )}

          {mode === "tag" && (
            <Checkbox
              className="flex gap-2 p-2 text-xs"
              checked={sign}
              onChange={(event) => setSign(event.target.checked)}
            >
              {t("commitMenu.signWithThisProfileSsshgpgKey")}
            </Checkbox>
          )}

          <Button size="sm" variant="primary" block disabled={!canCreate} onClick={createReference}>
            {t("commitMenu.create", { mode: mode })}
          </Button>
        </div>
      )}

      {commandUnavailable && <p className="text-xs text-text-tertiary">{commandUnavailable}</p>}
      {error && <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>}
    </ContextPopover>
  );
}
