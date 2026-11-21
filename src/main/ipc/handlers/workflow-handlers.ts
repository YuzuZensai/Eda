import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import type { Services } from "../../services";
import { invalidRequest } from "../../request-errors";
import { broadcast, handle, withRepositoryChange } from "../transport";
import { requireId, requireString } from "../validate";

export function registerWorkflowHandlers({
  workflows,
  rebase,
  replay,
  reset,
  historyReversal,
  historyRecovery,
}: Services) {
  handle(IPC_CHANNELS.historyResumeBranchCheckout, async (_event, rawId, recordId, phase) => {
    if (phase !== "original" && phase !== "undo" && phase !== "redo")
      throw invalidRequest(
        errorText("main.workflowHandlers.reviewTheInterruptedBranchActionFirst"),
      );

    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      await historyReversal.resumeBranchCheckout(id, requireId(recordId), phase);
      return ok(undefined);
    });
  });

  handle(IPC_CHANNELS.historyDismissUnstarted, async (_event, rawId, recordId) => {
    await historyReversal.dismissUnstarted(requireId(rawId), requireId(recordId));
    return ok(undefined);
  });

  handle(IPC_CHANNELS.historyResumeConfiguration, async (_event, rawId, recordId, direction) => {
    if (direction !== "undo" && direction !== "redo")
      throw invalidRequest(errorText("main.workflowHandlers.reviewTheInterruptedDirectionFirst"));

    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      await historyReversal.resumeConfiguration(id, requireId(recordId), direction);
      return ok(undefined);
    });
  });

  handle(IPC_CHANNELS.historyResumeIndex, async (_event, rawId, recordId, direction) => {
    if (direction !== "undo" && direction !== "redo")
      throw invalidRequest(errorText("main.workflowHandlers.reviewTheInterruptedDirectionFirst"));

    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(await historyReversal.resumeIndex(id, requireId(recordId), direction));
    });
  });

  handle(IPC_CHANNELS.historyResumeReset, async (_event, rawId, recordId, publishedCommits) => {
    if (
      typeof publishedCommits !== "number" ||
      !Number.isSafeInteger(publishedCommits) ||
      publishedCommits < 0
    )
      throw invalidRequest(
        errorText("main.workflowHandlers.reviewPublishedHistoryBeforeResumingTheReset"),
      );

    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(await historyReversal.resumeReset(id, requireId(recordId), publishedCommits));
    });
  });

  handle(IPC_CHANNELS.historyReconcile, async (_event, rawId, recordId, state) => {
    if (state !== "applied" && state !== "undone")
      throw invalidRequest(errorText("main.workflowHandlers.reviewTheRecoveryStateFirst"));
    const id = requireId(rawId);
    await historyReversal.reconcile(id, requireId(recordId), state);
    broadcast(IPC_EVENTS.repositoryChanged, id);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.historyReversals, async (_event, id) =>
    ok(await historyReversal.list(requireId(id))),
  );

  handle(
    IPC_CHANNELS.historyReverse,
    async (_event, rawId, recordId, direction, publishedCommits) => {
      if (direction !== "undo" && direction !== "redo")
        throw invalidRequest(errorText("main.workflowHandlers.chooseUndoOrRedo"));

      if (
        typeof publishedCommits !== "number" ||
        !Number.isSafeInteger(publishedCommits) ||
        publishedCommits < 0
      )
        throw invalidRequest(
          errorText("main.workflowHandlers.reviewThePublicationCountBeforeUndoOrRedo"),
        );

      const id = requireId(rawId);

      return withRepositoryChange(id, async () => {
        await historyReversal.execute(id, requireId(recordId), direction, publishedCommits);
        return ok(undefined);
      });
    },
  );

  handle(IPC_CHANNELS.historyRecoveryList, async (_event, id, source, offset) => {
    if (
      source !== "reflog" &&
      source !== "saved" &&
      source !== "unreachable" &&
      source !== "rewrites"
    )
      throw invalidRequest(errorText("main.workflowHandlers.chooseARecoverySource"));

    if (offset !== undefined && typeof offset !== "number")
      throw invalidRequest(errorText("main.workflowHandlers.chooseARecoveryPage"));

    return ok(await historyRecovery.list(requireId(id), source, offset));
  });

  handle(IPC_CHANNELS.historyRecoveryInspect, async (_event, id, oid) =>
    ok(
      await historyRecovery.inspect(requireId(id), requireString(oid, t("fields.recoveryCommit"))),
    ),
  );

  handle(IPC_CHANNELS.historyRecoveryRestore, async (_event, rawId, token, name) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(
        await historyRecovery.restore(
          id,
          requireId(token),
          requireString(name, t("fields.branchName")),
        ),
      );
    });
  });

  handle(IPC_CHANNELS.resetPrepare, async (_event, rawId, target, mode) => {
    if (mode !== "soft" && mode !== "mixed" && mode !== "hard")
      throw invalidRequest(errorText("main.workflowHandlers.chooseAResetMode"));

    return ok(
      await reset.prepare(requireId(rawId), requireString(target, t("fields.resetTarget")), mode),
    );
  });

  handle(IPC_CHANNELS.resetExecute, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(await reset.execute(id, requireId(rawToken)));
    });
  });

  handle(IPC_CHANNELS.replayPrepare, async (_event, rawId, kind, action, commits, mainline) => {
    if (
      (kind !== "cherry-pick" && kind !== "revert") ||
      (action !== "start" && action !== "continue" && action !== "skip" && action !== "abort")
    )
      throw invalidRequest(errorText("main.workflowHandlers.chooseACherryPickOrRevertAction"));

    if (
      commits !== undefined &&
      (!Array.isArray(commits) || commits.some((oid) => typeof oid !== "string"))
    )
      throw invalidRequest(errorText("main.workflowHandlers.chooseCommitIDsInExecutionOrder"));

    if (mainline !== undefined && typeof mainline !== "number")
      throw invalidRequest(errorText("main.workflowHandlers.chooseAMainlineParentNumber"));

    return ok(await replay.prepare(requireId(rawId), kind, action, commits, mainline));
  });

  handle(IPC_CHANNELS.replayExecute, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);

    return withRepositoryChange(id, async () => {
      return ok(await replay.execute(id, requireId(rawToken)));
    });
  });

  handle(IPC_CHANNELS.rebasePrepare, async (_event, rawId, action, onto, interactive) => {
    if (interactive !== undefined && typeof interactive !== "boolean")
      throw invalidRequest(errorText("main.workflowHandlers.chooseWhetherToEditTheRebasePlan"));

    if (
      action !== "start" &&
      action !== "continue" &&
      action !== "skip" &&
      action !== "abort" &&
      action !== "amend"
    )
      throw invalidRequest(errorText("main.workflowHandlers.chooseARebaseAction"));

    return ok(
      await rebase.prepare(
        requireId(rawId),
        action,
        onto === undefined ? undefined : requireString(onto, t("fields.rebaseBase")),
        interactive,
      ),
    );
  });

  handle(IPC_CHANNELS.rebaseExecute, async (_event, rawId, rawToken, plan, message) => {
    const id = requireId(rawId);
    const token = requireId(rawToken);

    return withRepositoryChange(id, async () => {
      return ok(await rebase.execute(id, token, plan, message));
    });
  });

  handle(IPC_CHANNELS.workflowFinishStash, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);
    const token = requireString(rawToken, t("fields.workflowToken"));

    return withRepositoryChange(id, async () => {
      await workflows.finishStash(id, token);
      return ok(undefined);
    });
  });

  handle(IPC_CHANNELS.workflowPredictUpstream, async (_event, id) =>
    ok(await workflows.predictUpstream(requireId(id))),
  );

  handle(IPC_CHANNELS.workflowPrepareStart, async (_event, id, source, mode) => {
    if (mode !== "ff" && mode !== "no-ff" && mode !== "ff-only" && mode !== "squash")
      throw invalidRequest(errorText("main.workflowHandlers.chooseASupportedMergePolicy"));

    return ok(
      await workflows.prepareStart(
        requireId(id),
        requireString(source, t("fields.sourceCommit")),
        mode,
      ),
    );
  });

  handle(IPC_CHANNELS.workflowStartMerge, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);
    const token = requireId(rawToken);

    return withRepositoryChange(id, async () => {
      return ok(await workflows.startMerge(id, token));
    });
  });

  handle(IPC_CHANNELS.workflowPrepareAbort, async (_event, id) =>
    ok(await workflows.prepareAbort(requireId(id))),
  );

  handle(IPC_CHANNELS.workflowAbortMerge, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);
    const token = requireId(rawToken);

    return withRepositoryChange(id, async () => {
      await workflows.abortMerge(id, token);
      return ok(undefined);
    });
  });

  handle(IPC_CHANNELS.workflowPrepareMerge, async (_event, id) =>
    ok(await workflows.prepareMerge(requireId(id))),
  );

  handle(IPC_CHANNELS.workflowContinueMerge, async (_event, rawRepository, rawId, message) => {
    const repositoryId = requireId(rawRepository);
    const id = requireId(rawId);

    if (typeof message !== "string" || !message.trim() || message.length > 1024 * 1024)
      throw invalidRequest(errorText("main.workflowHandlers.enterAMergeMessageWithinThe1MiBLimit"));

    return withRepositoryChange(repositoryId, async () => {
      return ok(await workflows.continueMerge(repositoryId, id, message));
    });
  });
}
