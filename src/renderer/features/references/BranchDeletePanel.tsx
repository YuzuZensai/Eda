import { deleteScopes, DeleteScopeChoices, type DeleteScope } from "./DeleteScopeChoices";
import { useReferenceAction } from "./hooks/useReferenceAction";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import { AppError, errorAction, errorMessage, GitError, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import type { BranchSummary } from "@shared/repository/repository-write";
import { useEffect, useRef, useState } from "react";
import {
  repositoryCommandDispatcher,
  repositoryCommandReason,
  type RepositoryCommandContext,
} from "../../commands/repository-commands";
import { Button, Checkbox, ErrorDialog } from "../../components/ui/index";
import { remoteForTrackingRef, type RemoteState } from "@shared/integrations/remotes";
import { useRepositoryStore } from "../../stores/repository-store";
import { CredentialFields } from "../sync/TransportFields";

export function BranchDeletePanel({
  context,
  branch,
  onClose,
  onBusyChange,
}: {
  context: RepositoryCommandContext;
  branch: BranchSummary;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { repositoryId } = context;
  const dispatch = repositoryCommandDispatcher(context);
  const [target] = useState(branch);
  const { busy, setBusy, assertContext, running, error, setError, run, refresh } =
    useReferenceAction(context, {
      onClose,
      onBusyChange,
      initiallyBusy: true,
      fallback: errorText("referenceMenu.theReferenceActionFailed"),
    });
  useRepositoryStore((state) => state.writing);
  const unavailable = repositoryCommandReason(context);
  const [targets, setTargets] = useState<ReturnType<typeof branchDeleteTargets> | null>(null);

  const [scope, setScope] = useState<DeleteScope>(branch.remote ? "remote" : "local");

  const [force, setForce] = useState(false);
  const [remoteDeleted, setRemoteDeleted] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [auth, setAuth] = useState({ username: "", password: "" });
  const review = useRef<HTMLDivElement>(null);

  useEffect(() => {
    review.current?.focus();
  }, []);

  const includesLocal = scope !== "remote";
  const includesRemote = scope !== "local";

  const branchChoices = deleteScopes(
    !!targets?.local && !targets.localBlocked,
    !!targets?.remote && !remoteDeleted,
  );

  const close = () => {
    if (!running.current) onClose();
  };

  const requireResult = <T,>(result: Result<T>): T => {
    if (!result.ok) {
      setNeedsAuth(result.error.kind === "auth-failed");
      throw new GitError(result.error);
    }

    return result.value;
  };

  const deleteRef = () =>
    run(async () => {
      if (!targets) throw new AppError(ERROR_CODE.BRANCH_TARGETS_NOT_READY);

      if (includesLocal && (!targets.local || targets.localBlocked))
        throw new AppError(
          errorText("errors.operationBlocked", {
            reason: targets.localBlocked ?? t("referenceMenu.noMatchingLocalBranchExists"),
          }),
        );

      try {
        if (includesRemote && !remoteDeleted) {
          if (!targets.remote) throw new AppError(ERROR_CODE.TRACKED_BRANCH_MISSING);
          const credentials = needsAuth ? auth : undefined;

          const preview = requireResult(
            await window.eda.remotes.preparePush({
              repositoryId,
              remote: targets.remote.name,
              branch: targets.remote.branch,
              destination: targets.remote.branch,
              mode: "delete",
              setUpstream: false,
              ...(credentials ? { credentials } : {}),
            }),
          );

          assertContext();
          requireResult(await window.eda.remotes.push(repositoryId, preview.token, credentials));
          setRemoteDeleted(true);
          if (includesLocal) setScope("local");
        }

        if (includesLocal && targets.local) {
          assertContext();

          requireResult(
            await dispatch("deleteBranch", {
              repositoryId,
              name: targets.local.name,
              ...(force ? { force: true } : {}),
            }),
          );
        }
      } finally {
        await refresh();
      }
    });

  useEffect(() => {
    let active = true;
    running.current = true;
    onBusyChange(true);

    void (async () => {
      try {
        assertContext();
        const result = await window.eda.remotes.inspect(repositoryId);
        if (!active) return;
        assertContext();
        const resolved = branchDeleteTargets(target, requireResult(result));
        setTargets(resolved);
        if ((!resolved.local || resolved.localBlocked) && resolved.remote) setScope("remote");
      } catch (failure) {
        if (active)
          setError([errorMessage(failure), errorAction(failure)].filter(Boolean).join(" "));
      } finally {
        if (active) {
          running.current = false;
          setBusy(false);
          onBusyChange(false);
        }
      }
    })();

    return () => {
      active = false;
      onBusyChange(false);
    };
  }, [context, repositoryId, target]);

  return (
    <div ref={review} tabIndex={-1} className="space-y-3 p-2 text-xs">
      {busy && !targets && <p role="status">{t("referenceMenu.loadingBranchTargets")}</p>}

      {targets && (
        <>
          {branchChoices.length > 0 && (
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="mb-2 font-medium">{t("referenceMenu.deleteBranchFrom")}</legend>

              <DeleteScopeChoices
                name="delete-scope"
                choices={branchChoices}
                scope={scope}
                onChange={setScope}
              />
            </fieldset>
          )}

          {targets.local && (
            <p className="break-all">{t("referenceMenu.local", { name: targets.local.name })}</p>
          )}

          {targets.remote && !remoteDeleted && (
            <p className="break-all">
              {t("referenceMenu.remote", {
                name: targets.remote.name,
                branch: targets.remote.branch,
              })}
            </p>
          )}

          {!targets.remote && <p>{t("referenceMenu.noTrackedRemoteBranchIsConfigured")}</p>}
          {targets.localBlocked && <p>{targets.localBlocked}</p>}

          {includesRemote && (
            <p>{t("referenceMenu.thisRemovesTheBranchFromTheRemoteRepositoryForEveryone")}</p>
          )}

          {includesLocal && !targets.localBlocked && (
            <Checkbox
              checked={force}
              disabled={busy}
              onChange={(event) => setForce(event.target.checked)}
            >
              {t("referenceMenu.deleteLocalBranchEvenIfUnmerged")}
            </Checkbox>
          )}
        </>
      )}

      {remoteDeleted && (
        <p role="status">
          {t("referenceMenu.remoteBranchDeleted", {
            value1: includesLocal
              ? t("referenceMenu.localDeletionHasNotCompletedRetryToDeleteItLocally")
              : "",
          })}
        </p>
      )}

      {needsAuth && includesRemote && !remoteDeleted && (
        <CredentialFields
          value={auth}
          onChange={setAuth}
          disabled={busy}
          shortLabels
          usernameLabel={t("referenceMenu.hTtpsUsername")}
        />
      )}

      <div className="flex gap-2">
        <Button size="sm" autoFocus disabled={busy} onClick={close}>
          {t("common.cancel")}
        </Button>

        {branchChoices.some(([value]) => value === scope) && (
          <Button
            size="sm"
            variant="danger"
            busy={busy}
            disabled={
              !!unavailable ||
              !targets ||
              (includesLocal && (!targets.local || !!targets.localBlocked)) ||
              (includesRemote && !targets.remote) ||
              (needsAuth &&
                includesRemote &&
                !remoteDeleted &&
                (!auth.username.trim() || !auth.password))
            }
            onClick={() => void deleteRef()}
          >
            {t(
              scope === "both"
                ? "referenceMenu.deleteBoth"
                : scope === "local"
                  ? "referenceMenu.deleteLocal"
                  : "referenceMenu.deleteRemote",
            )}
          </Button>
        )}
      </div>

      {error && <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>}
    </div>
  );
}

function branchDeleteTargets(branch: BranchSummary, state: RemoteState) {
  const current = state.branches.find(
    (item) => item.name === branch.name && item.remote === branch.remote,
  );
  const remoteRef = branch.remote ? current?.name : current?.upstream;
  const remote = remoteForTrackingRef(state.remotes, remoteRef);
  const destination = remote && remoteRef ? remoteRef.slice(remote.name.length + 1) : undefined;
  const locals =
    branch.remote && remoteRef
      ? state.branches.filter((item) => !item.remote && item.upstream === remoteRef)
      : [];
  const local = branch.remote
    ? (locals.find((item) => item.name === destination) ??
      (locals.length === 1 ? locals[0] : undefined))
    : current;
  const localBlocked = local?.isHead
    ? t("branchDeleteTargets.checkOutAnotherBranchBeforeDeletingThisLocalBranch")
    : local?.worktreePath
      ? t("branchDeleteTargets.thisBranchIsCheckedOutInSwitchThatWorktreeToAnotherBranchFirst", {
          worktreePath: local.worktreePath,
        })
      : undefined;

  return {
    local,
    localBlocked,
    remote: remote && destination ? { name: remote.name, branch: destination } : undefined,
  };
}
