import { commitSignatureLabel } from "../../components/ui/display/commit-signature-label";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import type { Result } from "@shared/errors";
import { AppError, errorAction, errorMessage, GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { referenceLink } from "@shared/repository/reference-link";
import type { TransportCredentials } from "@shared/integrations/remotes";
import type {
  BranchSummary,
  TagSummary,
  TagVerification,
} from "@shared/repository/repository-write";
import {
  CopyIcon as Copy,
  DownloadIcon as Download,
  BranchIcon as GitBranch,
  GitCommitHorizontalIcon,
  GitMergeIcon as GitMerge,
  GitPullRequestArrowIcon as GitPullRequestArrow,
  LinkIcon as Link,
  PencilIcon as Pencil,
  ShieldCheckIcon as ShieldCheck,
  TagIcon,
  Trash2Icon as Trash2,
  UploadIcon as Upload,
} from "../../components/ui/icons";
import { useEffect, useRef, useState } from "react";
import {
  captureRepositoryCommand,
  repositoryCommandDispatcher,
  repositoryCommandReason,
} from "../../commands/repository-commands";
import {
  Button,
  CodeBlock,
  ContextPopover,
  ErrorDialog,
  Field,
  Input,
  MenuItem,
  MenuSubmenu,
} from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";
import { copyText } from "../../utils/clipboard";
import { DirectPush } from "../sync/DirectPush";
import { useDirectFetch } from "../sync/hooks/useDirectFetch";
import { HttpsAuthenticationDialog } from "../sync/HttpsAuthenticationDialog";
import { GitHubSignInDialog } from "../connections/GitHubSignInDialog";
import { MergeStartDialog } from "../workflows/MergeStartDialog";
import { RebaseDialog } from "../workflows/RebaseDialog";
import { BranchDeletePanel } from "./BranchDeletePanel";
import { TagDeletePanel } from "./TagDeletePanel";

export type ReferenceTarget = (
  | { kind: "branch"; ref: BranchSummary }
  | {
      kind: "tag";
      ref: TagSummary;
      remoteName?: string;
      remoteNames?: string[];
      remoteOid?: string;
      local?: boolean;
    }
) & { x: number; y: number };

const actionTitleKeys = {
  delete: { branch: "referenceMenu.deleteBranchTitle", tag: "referenceMenu.deleteTagTitle" },
  rename: { branch: "referenceMenu.renameBranchTitle", tag: "referenceMenu.renameTagTitle" },
  create: {
    branch: "referenceMenu.createLocalBranchTitle",
    tag: "referenceMenu.createLocalTagTitle",
  },
  verify: { branch: "referenceMenu.verifyBranchTitle", tag: "referenceMenu.verifyTagTitle" },
  push: { branch: "directPush.push", tag: "referenceMenu.pushTag" },
} as const;

export function ReferenceMenu({
  repositoryId,
  target,
  onClose,
  onChanged,
}: {
  repositoryId: string;
  target: ReferenceTarget;
  onClose: () => void;
  onChanged?: (() => void) | undefined;
}) {
  const [context] = useState(() => captureRepositoryCommand(repositoryId));
  const dispatch = repositoryCommandDispatcher(context);
  useRepositoryStore((state) => state.writing);
  const unavailable = repositoryCommandReason(context);

  const [mode, setMode] = useState<
    "menu" | "rename" | "create" | "delete" | "verify" | "merge" | "rebase" | "push"
  >("menu");

  const [name, setName] = useState(target.ref.name);
  const [error, setError] = useState<string | null>(null);
  const [working, setBusy] = useState(false);
  const tagFetch = useDirectFetch(repositoryId);
  const busy = working || tagFetch.busy;
  const running = useRef(false);
  const deleteRunning = useRef(false);
  const [verification, setVerification] = useState<TagVerification | null>(null);
  const review = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === "verify") review.current?.focus();
  }, [mode]);

  const blocked = target.kind === "branch" && !!target.ref.worktreePath && !target.ref.isHead;
  const ReferenceIcon = target.kind === "branch" ? GitBranch : TagIcon;
  const close = () => {
    if (!running.current && !deleteRunning.current && !tagFetch.busy) onClose();
  };

  const assertContext = () => {
    const reason = repositoryCommandReason(context);
    if (reason) throw new AppError(errorText("errors.operationBlocked", { reason }));
  };

  const requireResult = <T,>(result: Result<T>): T => {
    if (!result.ok) {
      throw new GitError(result.error);
    }

    return result.value;
  };

  const run = async (
    work: () => Promise<void>,
    options: { dismiss?: boolean; write?: boolean } = {},
  ) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);

    try {
      if (options.write !== false) assertContext();
      await work();
      if (options.dismiss !== false) onClose();
    } catch (failure) {
      setError(
        [
          errorMessage(failure, errorText("referenceMenu.theReferenceActionFailed")),
          errorAction(failure),
        ]
          .filter(Boolean)
          .join(" "),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!repositoryCommandReason(context)) await useRepositoryStore.getState().refresh();
  };

  const fetchTag = async (credentials?: TransportCredentials) => {
    if (repositoryCommandReason(context) || target.kind !== "tag" || !target.remoteName) return;
    if (await tagFetch.fetch(target.remoteName, credentials, { tag: target.ref.name })) {
      onChanged?.();
      onClose();
    }
  };

  if (tagFetch.authentication)
    return (
      <HttpsAuthenticationDialog
        title={t("referenceMenu.fetchTag")}
        description={t("directFetchActions.signInToFetchCredentialsAreUsedForThisActionOnly", {
          authentication: tagFetch.authentication,
        })}
        submitLabel={t("directFetchActions.retryFetch")}
        error={tagFetch.error}
        busy={tagFetch.busy}
        onClose={close}
        onSubmit={(credentials) => void fetchTag(credentials)}
      />
    );

  if (tagFetch.githubAuthentication)
    return <GitHubSignInDialog accessDenied={tagFetch.githubAccessDenied} onClose={close} />;

  if (mode === "push" && target.kind === "tag")
    return (
      <DirectPush
        repositoryId={repositoryId}
        tag={{ name: target.ref.name, ...(target.remoteName ? { remote: target.remoteName } : {}) }}
        onChanged={onChanged}
        onClose={onClose}
      />
    );

  if (mode === "merge")
    return (
      <MergeStartDialog repositoryId={repositoryId} source={target.ref.oid} onClose={onClose} />
    );

  if (mode === "rebase")
    return (
      <RebaseDialog
        repositoryId={repositoryId}
        action="start"
        onto={target.ref.oid}
        onClose={onClose}
      />
    );

  return (
    <ContextPopover
      role={mode === "menu" ? "menu" : "dialog"}
      aria-label={
        mode === "menu"
          ? t(target.kind === "branch" ? "referenceMenu.branchActions" : "referenceMenu.tagActions")
          : t(actionTitleKeys[mode][target.kind])
      }
      onClose={close}
      position={target}
      className="w-[312px]"
    >
      <p
        className="truncate px-2 py-1 text-xs font-semibold text-text-tertiary"
        title={target.ref.name}
      >
        {target.ref.name}
      </p>

      {mode === "menu" && (
        <>
          <MenuItem
            disabled={
              busy ||
              !!unavailable ||
              (target.kind === "tag" && target.local === false) ||
              (target.kind === "branch" && (target.ref.isHead || blocked))
            }
            onClick={() =>
              void run(async () => {
                requireResult(
                  await dispatch(target.kind === "tag" ? "checkoutTag" : "checkoutBranch", {
                    repositoryId,
                    name: target.ref.name,
                  }),
                );

                await refresh();
              })
            }
          >
            <GitBranch size={13} />

            {t("referenceMenu.checkOut", {
              kind: target.kind,
              value2: target.kind === "tag" ? t("referenceMenu.detachedHead") : "",
            })}
          </MenuItem>

          {target.kind === "branch" && (
            <>
              <MenuItem
                disabled={!!unavailable || target.ref.isHead}
                onClick={() => setMode("rebase")}
              >
                <GitPullRequestArrow size={13} />
                {t("referenceMenu.rebaseCurrentBranchOntoThis")}
              </MenuItem>

              <MenuItem
                disabled={!!unavailable || target.ref.isHead}
                onClick={() => setMode("merge")}
              >
                <GitMerge size={13} />
                {t("referenceMenu.mergeIntoCurrentBranch")}
              </MenuItem>

              <MenuItem
                disabled={!!unavailable || blocked}
                onClick={() => {
                  setName(
                    target.ref.remote
                      ? target.ref.name.split("/").slice(1).join("/")
                      : target.ref.name,
                  );

                  setMode(target.ref.remote ? "create" : "rename");
                }}
              >
                <Pencil size={13} />
                {target.ref.remote
                  ? t("referenceMenu.createLocalBranchHere")
                  : t("referenceMenu.renameBranch")}
              </MenuItem>
            </>
          )}

          <MenuSubmenu label={t("common.copy")} icon={<Copy size={13} aria-hidden="true" />}>
            <MenuItem onClick={() => void run(() => copyText(target.ref.name), { write: false })}>
              <ReferenceIcon size={13} aria-hidden="true" />
              {t("common.name")}
            </MenuItem>

            <MenuItem
              onClick={() =>
                void run(
                  () =>
                    copyText(
                      target.kind === "tag" ? (target.remoteOid ?? target.ref.oid) : target.ref.oid,
                    ),
                  { write: false },
                )
              }
            >
              <GitCommitHorizontalIcon size={13} aria-hidden="true" />
              {t("referenceMenu.sha")}
            </MenuItem>

            <MenuItem
              onClick={() =>
                void run(
                  async () => {
                    const url =
                      target.kind === "tag" && target.remoteName
                        ? referenceLink(
                            requireResult(
                              await window.eda.remotes.inspect(repositoryId),
                            ).remotes.find((remote) => remote.name === target.remoteName)
                              ?.pushUrls[0] ?? "",
                            "tag",
                            target.ref.name,
                          )
                        : requireResult(
                            await window.eda.repository.referenceUrl(
                              repositoryId,
                              target.kind === "branch" && target.ref.remote
                                ? "remote-branch"
                                : target.kind,
                              target.ref.name,
                            ),
                          );

                    if (!url) throw new AppError(ERROR_CODE.REMOTE_BROWSER_URL_UNAVAILABLE);
                    await copyText(url);
                  },
                  { write: false },
                )
              }
            >
              <Link size={13} aria-hidden="true" />
              {t("referenceMenu.browserUrl")}
            </MenuItem>
          </MenuSubmenu>

          {target.kind === "tag" && (
            <>
              {target.local === false && target.remoteName && (
                <MenuItem disabled={busy || !!unavailable} onClick={() => void fetchTag()}>
                  <Download size={13} />
                  {t("referenceMenu.fetchTag")}
                </MenuItem>
              )}

              <MenuItem
                disabled={busy || !!unavailable || target.local === false}
                onClick={() => setMode("push")}
              >
                <Upload size={13} />
                {t("referenceMenu.pushTag")}
              </MenuItem>

              <MenuItem
                disabled={busy || !!unavailable || target.local === false}
                onClick={() => {
                  setMode("verify");

                  void run(
                    async () => {
                      setVerification(
                        requireResult(
                          await window.eda.repository.verifyTag({
                            repositoryId,
                            name: target.ref.name,
                          }),
                        ),
                      );
                    },
                    { dismiss: false },
                  );
                }}
              >
                <ShieldCheck size={13} />
                {t("referenceMenu.verifyTagSignature")}
              </MenuItem>

              {target.remoteName && target.local !== false && (
                <p className="px-2 py-1 text-xs text-text-tertiary">
                  {t("referenceMenu.localTagActions")}
                </p>
              )}

              {target.local === false && (
                <p className="px-2 py-1 text-xs text-text-tertiary">
                  {t("referenceMenu.fetchTagFirst")}
                </p>
              )}
            </>
          )}

          <MenuItem danger disabled={busy || !!unavailable} onClick={() => setMode("delete")}>
            <Trash2 size={13} />

            {t(
              target.kind === "branch"
                ? "referenceMenu.deleteBranchAction"
                : "referenceMenu.deleteTagAction",
            )}
          </MenuItem>
        </>
      )}

      {(mode === "rename" || mode === "create") && (
        <form
          className="space-y-3 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || busy) return;

            void run(async () => {
              requireResult(
                mode === "create"
                  ? await dispatch("createBranch", {
                      repositoryId,
                      name: name.trim(),
                      startPoint: target.ref.oid,
                      checkout: true,
                    })
                  : await dispatch("renameBranch", {
                      repositoryId,
                      from: target.ref.name,
                      to: name.trim(),
                    }),
              );

              await refresh();
            });
          }}
        >
          <Field
            label={
              mode === "rename"
                ? t("referenceMenu.renameBranchTo")
                : t("referenceMenu.newLocalBranchName")
            }
          >
            {(field) => (
              <Input
                {...field}
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>

          <Button
            type="submit"
            size="sm"
            busy={busy}
            disabled={
              !!unavailable || !name.trim() || (mode === "rename" && name === target.ref.name)
            }
          >
            {mode === "rename"
              ? t("referenceMenu.renameBranchTitle")
              : t("referenceMenu.createLocalBranch")}
          </Button>
        </form>
      )}

      {mode === "delete" && target.kind === "tag" && (
        <TagDeletePanel
          repositoryId={repositoryId}
          name={target.ref.name}
          remoteOnly={target.local === false}
          {...((target.remoteName ?? target.remoteNames?.[0])
            ? { initialRemote: (target.remoteName ?? target.remoteNames?.[0])! }
            : {})}
          onChanged={onChanged}
          onClose={onClose}
          onBusyChange={(busy) => {
            deleteRunning.current = busy;
          }}
        />
      )}

      {mode === "delete" && target.kind === "branch" && (
        <BranchDeletePanel
          context={context}
          branch={target.ref}
          onClose={onClose}
          onBusyChange={(busy) => {
            deleteRunning.current = busy;
          }}
        />
      )}

      {mode === "verify" && (
        <div ref={review} tabIndex={-1} className="space-y-2 p-2 text-xs">
          <Button size="sm" autoFocus disabled={busy} onClick={close}>
            {t("common.close")}
          </Button>
          {busy && <p role="status">{t("referenceMenu.verifyingTagSignature")}</p>}

          {target.kind === "tag" && (
            <p>
              {target.ref.annotated
                ? t("referenceMenu.annotatedTag", { value1: target.ref.tagger ?? "" })
                : t("referenceMenu.lightweightTag")}
            </p>
          )}

          {target.kind === "tag" && target.ref.message && (
            <CodeBlock label={t("referenceMenu.tagMessage")} wrap>
              {target.ref.message}
            </CodeBlock>
          )}

          {verification && (
            <>
              <p role="status">
                {verification.status === "unsigned"
                  ? t("referenceMenu.unsignedTag")
                  : commitSignatureLabel(verification)}
              </p>

              <CodeBlock label={t("referenceMenu.signatureVerificationOutput")} wrap>
                {verification.diagnostics}
              </CodeBlock>
            </>
          )}
        </div>
      )}

      {unavailable && <p className="px-2 py-1 text-xs text-text-tertiary">{unavailable}</p>}
      {(error || tagFetch.error) && (
        <ErrorDialog
          onDismiss={() => {
            setError(null);
            tagFetch.setError(null);
          }}
        >
          {error ?? tagFetch.error}
        </ErrorDialog>
      )}
    </ContextPopover>
  );
}
