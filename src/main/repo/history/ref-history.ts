import { hasSpecialIndexFlags } from "../../git/parsers/status-parser";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import type { HistoryDirection } from "@shared/workflows/history-recovery";
import { randomUUID } from "node:crypto";
import {
  branchConfiguration,
  withBranchConfiguration,
  withBranchConfigurations,
} from "../../git/configuration/branch-configuration";
import type { GitService } from "../../git/git-service";
import { readWorkflowState } from "../../git/operations/workflow-state";
import type { WorkflowJournal, WorkflowJournalRecord } from "../../persistence/workflow-journal";
import {
  fingerprintContents,
  readWorkflowContents,
  workflowFingerprint,
} from "../workflows/workflow-fingerprint";
import { ensureRecoveryRefs } from "./rewrite-history";

const invalid = (message: ErrorText) =>
  new GitError({
    kind: "invalid-input",
    operation: t("operations.reverseReferenceAction"),
    message,
  });

export type RefHistoryDescriptor =
  | { kind: "branch-create"; name: string; tip: string; checkedOut: boolean }
  | { kind: "branch-delete"; name: string; tip: string }
  | { kind: "branch-rename"; from: string; to: string; tip: string }
  | { kind: "checkout"; name: string | null; tip: string };

function label(descriptor: RefHistoryDescriptor) {
  switch (descriptor.kind) {
    case "branch-create":
      return t("main.refHistory.createBranch", { name: descriptor.name });
    case "branch-delete":
      return t("main.refHistory.deleteBranch", { name: descriptor.name });
    case "branch-rename":
      return t("main.refHistory.renameBranchTo", { from: descriptor.from, to: descriptor.to });
    case "checkout":
      return descriptor.name
        ? t("main.refHistory.checkoutBranch", { name: descriptor.name })
        : t("main.refHistory.checkoutDetachedCommit");
  }
}

async function branchTip(git: GitService, root: string, name: string): Promise<string | null> {
  const result = await git.exec(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {
    cwd: root,
    operation: t("operations.inspectBranchReference"),
    allowedExitCodes: [0, 1],
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function requireBranch(git: GitService, root: string, name: string, tip: string) {
  if ((await branchTip(git, root, name)) !== tip)
    throw invalid(
      errorText("main.refHistory.branchChangedAfterThisActionRefreshUndoRedo", { name: name }),
    );
}

export class RefHistory {
  constructor(
    private readonly git: GitService,
    private readonly journal: WorkflowJournal,
  ) {}

  async run(
    root: string,
    repositoryId: string,
    identity: Identity,
    descriptor: RefHistoryDescriptor,
    work: () => Promise<void>,
  ): Promise<void> {
    if (
      this.journal
        .refActions(root)
        .filter(
          (record) =>
            record.state !== "completed" ||
            ["undoing", "redoing"].includes(record.refOperation?.state ?? ""),
        ).length >= 100
    )
      throw invalid(errorText("main.refHistory.thereAreTooManyUnfinishedReferenceActionsInspect"));

    const before = await this.git.status(root);
    const contents = await readWorkflowContents(this.git, root);
    const beforeFingerprint = fingerprintContents(before, contents);
    const startContentFingerprint = fingerprintContents(before.changes, contents);
    const configName =
      descriptor.kind === "branch-create" || descriptor.kind === "branch-delete"
        ? descriptor.name
        : descriptor.kind === "branch-rename"
          ? descriptor.to
          : undefined;

    const beforeConfig = configName
      ? await branchConfiguration(this.git, root, configName)
      : undefined;
    const beforeFromConfig =
      descriptor.kind === "branch-rename"
        ? await branchConfiguration(this.git, root, descriptor.from)
        : undefined;

    if (
      descriptor.kind === "branch-create" &&
      (await branchTip(this.git, root, descriptor.name)) !== null
    )
      throw invalid(errorText("main.refHistory.theBranchAlreadyExistsRefreshBeforeCreatingIt"));

    if (descriptor.kind === "branch-delete")
      await requireBranch(this.git, root, descriptor.name, descriptor.tip);

    if (descriptor.kind === "branch-rename") {
      await requireBranch(this.git, root, descriptor.from, descriptor.tip);
      if ((await branchTip(this.git, root, descriptor.to)) !== null)
        throw invalid(errorText("main.refHistory.theDestinationBranchAlreadyExists"));
    }

    const record: WorkflowJournalRecord = {
      version: 1,
      id: randomUUID(),
      repositoryId,
      profileId: identity.id,
      root,
      identity,
      mode: descriptor.kind === "checkout" ? "checkout" : "branch",
      head: before.branch.oid ?? "",
      ...(before.branch.head ? { branch: before.branch.head } : {}),
      incoming: [],
      workflowToken: `${beforeFingerprint}:refs`,
      tree: "",
      message: label(descriptor),
      author: identity.gitName,
      email: identity.gitEmail,
      signing: false,
      state: "prepared",
      updatedAt: new Date().toISOString(),
      refOperation: {
        ...(descriptor.kind === "branch-rename" && beforeFromConfig
          ? {
              beforeFromConfig,
              afterFromConfig: [],
            }
          : {}),
        ...(configName && beforeConfig
          ? {
              beforeConfig,
              afterConfig:
                descriptor.kind === "branch-delete"
                  ? []
                  : descriptor.kind === "branch-rename"
                    ? await branchConfiguration(
                        this.git,
                        root,
                        descriptor.to,
                        undefined,
                        descriptor.from,
                      )
                    : beforeConfig,
            }
          : {}),
        kind: descriptor.kind,
        beforeHead: before.branch.oid ?? null,
        beforeBranch: before.branch.detached ? null : (before.branch.head ?? null),
        beforeFingerprint,
        startContentFingerprint,
        cleanStart: before.changes.length === 0,
        beforeIndexFlags: (
          await this.git.exec(["ls-files", "-v", "-z"], {
            cwd: root,
            operation: t("operations.captureReferenceStartingFlags"),
          })
        ).stdout,
        afterHead:
          descriptor.kind === "checkout" ||
          (descriptor.kind === "branch-create" && descriptor.checkedOut)
            ? descriptor.tip
            : (before.branch.oid ?? null),
        afterBranch:
          descriptor.kind === "checkout"
            ? descriptor.name
            : descriptor.kind === "branch-create" && descriptor.checkedOut
              ? descriptor.name
              : descriptor.kind === "branch-rename" && before.branch.head === descriptor.from
                ? descriptor.to
                : before.branch.detached
                  ? null
                  : (before.branch.head ?? null),
        afterFingerprint: "",
        state: "applied",
        ...(descriptor.kind === "branch-create"
          ? { to: descriptor.name, tip: descriptor.tip, checkedOut: descriptor.checkedOut }
          : descriptor.kind === "branch-delete"
            ? { to: descriptor.name, tip: descriptor.tip }
            : descriptor.kind === "branch-rename"
              ? { from: descriptor.from, to: descriptor.to, tip: descriptor.tip }
              : { tip: descriptor.tip, ...(descriptor.name ? { to: descriptor.name } : {}) }),
      },
    };

    record.refOperation!.recoveryRef = `refs/eda/reference/${record.id}`;
    this.journal.save(record);

    try {
      await ensureRecoveryRefs(
        this.git,
        root,
        record.refOperation!.recoveryRef,
        referenceObjects(record),
      );
      await work();

      const after = await this.git.status(root);
      const afterFingerprint = await workflowFingerprint(this.git, root, after);

      switch (descriptor.kind) {
        case "branch-create":
          await requireBranch(this.git, root, descriptor.name, descriptor.tip);
          break;
        case "branch-delete":
          if ((await branchTip(this.git, root, descriptor.name)) !== null)
            throw invalid(
              errorText("main.refHistory.branchWasNotDeleted", { name: descriptor.name }),
            );
          break;
        case "branch-rename":
          if ((await branchTip(this.git, root, descriptor.from)) !== null)
            throw invalid(
              errorText("main.refHistory.thePreviousBranchNameStillExists", {
                from: descriptor.from,
              }),
            );
          await requireBranch(this.git, root, descriptor.to, descriptor.tip);
          break;
        case "checkout":
          if (descriptor.name) {
            if (after.branch.head !== descriptor.name || after.branch.detached)
              throw invalid(
                errorText("main.refHistory.gitDidNotCheckOut", { name: descriptor.name }),
              );
            await requireBranch(this.git, root, descriptor.name, descriptor.tip);
          } else if (!after.branch.detached || after.branch.oid !== descriptor.tip)
            throw invalid(errorText("main.refHistory.gitDidNotCheckOutTheSelectedCommit"));
          break;
      }

      record.refOperation!.afterHead = after.branch.oid ?? null;
      record.refOperation!.afterBranch = after.branch.detached ? null : (after.branch.head ?? null);
      record.refOperation!.afterFingerprint = afterFingerprint;
      record.refOperation!.afterIndexFlags = (
        await this.git.exec(["ls-files", "-v", "-z"], {
          cwd: root,
          operation: t("operations.captureReferenceResultFlags"),
        })
      ).stdout;

      if (configName)
        record.refOperation!.afterConfig = await branchConfiguration(this.git, root, configName);

      if (descriptor.kind === "branch-rename")
        record.refOperation!.afterFromConfig = await branchConfiguration(
          this.git,
          root,
          descriptor.from,
        );

      record.state = "completed";
      record.updatedAt = new Date().toISOString();
      this.journal.save(record);
    } catch (error) {
      record.state = "paused";
      record.updatedAt = new Date().toISOString();
      this.journal.save(record);
      throw error;
    }

    for (const expired of this.journal.expiredRefActions(root)) {
      const ref = expired.refOperation?.recoveryRef;

      if (ref) {
        if (ref !== `refs/eda/reference/${expired.id}`) continue;

        try {
          await validateReferenceObjects(this.git, expired);
          await this.git.exec(["update-ref", "--stdin"], {
            cwd: root,
            operation: t("operations.expireReferenceRecovery"),
            stdin:
              referenceObjects(expired)
                .map(([suffix, oid]) => `delete ${ref}/${suffix} ${oid}`)
                .join("\n") + "\n",
          });
        } catch {
          continue;
        }
      }

      this.journal.remove(expired.id);
    }
  }
}

function referenceObjects(record: WorkflowJournalRecord): [string, string][] {
  const operation = record.refOperation!;
  return [
    ...(operation.beforeHead ? [["head", operation.beforeHead] as [string, string]] : []),
    ...(operation.tip ? [["tip", operation.tip] as [string, string]] : []),
  ];
}

async function validateReferenceObjects(git: GitService, record: WorkflowJournalRecord) {
  const ref = record.refOperation?.recoveryRef;

  if (!ref) return;
  if (ref !== `refs/eda/reference/${record.id}`)
    throw invalid(errorText("main.refHistory.theSavedReferenceNamespaceChanged"));

  for (const [suffix, oid] of referenceObjects(record)) {
    const result = await git.exec(["rev-parse", "--verify", "--quiet", `${ref}/${suffix}`], {
      cwd: record.root,
      operation: t("operations.validateReferenceRecovery"),
      allowedExitCodes: [0, 1],
    });

    if (result.exitCode !== 0 || result.stdout.trim() !== oid)
      throw invalid(
        errorText("main.refHistory.aSavedReferenceIsMissingOrChangedInspectHistoryRecovery"),
      );
  }
}

export async function releaseReferenceObjects(git: GitService, record: WorkflowJournalRecord) {
  const ref = record.refOperation?.recoveryRef;

  if (!ref || ref !== `refs/eda/reference/${record.id}`) return;

  const deletes: string[] = [];

  for (const [suffix, oid] of referenceObjects(record)) {
    const current = await git.exec(["rev-parse", "--verify", "--quiet", `${ref}/${suffix}`], {
      cwd: record.root,
      operation: t("operations.inspectDismissedReferenceRecovery"),
      allowedExitCodes: [0, 1],
    });

    if (current.exitCode === 0 && current.stdout.trim() === oid)
      deletes.push(`delete ${ref}/${suffix} ${oid}`);
  }

  if (deletes.length)
    await git.exec(["update-ref", "--stdin"], {
      cwd: record.root,
      operation: t("operations.releaseDismissedReferenceRecovery"),
      stdin: `${deletes.join("\n")}\n`,
    });
}

async function checkoutState(
  git: GitService,
  root: string,
  branch: string | null,
  head: string | null,
) {
  const status = await git.status(root);
  if ((status.branch.oid ?? null) !== (head ?? null))
    throw invalid(errorText("main.refHistory.headChangedSinceThisReferenceAction"));
  if ((status.branch.detached ? null : (status.branch.head ?? null)) !== branch)
    throw invalid(errorText("main.refHistory.theCheckedOutBranchChangedSinceThisReferenceAction"));
}

export async function validateRefHistory(
  git: GitService,
  record: WorkflowJournalRecord,
  options: { pendingConfiguration?: boolean } = {},
): Promise<HistoryDirection> {
  const operation = record.refOperation;

  if (!operation)
    throw invalid(errorText("main.refHistory.thisReferenceActionHasNoReversalRecord"));
  if (record.state !== "completed")
    throw invalid(
      errorText("main.refHistory.thisReferenceActionDidNotCompleteInspectRepositoryState"),
    );
  if (operation.state === "undoing" || operation.state === "redoing")
    throw invalid(
      errorText(
        "main.refHistory.thisReferenceReversalWasInterruptedInspectTheRefsBeforeContinuing",
      ),
    );
  if (operation.blockedReason)
    throw invalid(errorText("errors.operationBlocked", { reason: operation.blockedReason }));

  await validateReferenceObjects(git, record);

  if (await readWorkflowState(git, record.root, await git.status(record.root)))
    throw invalid(
      errorText(
        "main.refHistory.finishOrAbortTheCurrentGitOperationBeforeChangingReferenceHistory",
      ),
    );

  const undo = operation.state === "applied";
  const expectedFlags = undo ? operation.afterIndexFlags : operation.beforeIndexFlags;

  if (expectedFlags !== undefined) {
    const flags = (
      await git.exec(["ls-files", "-v", "-z"], {
        cwd: record.root,
        operation: t("operations.validateReferenceIndexFlags"),
      })
    ).stdout;

    if (flags !== expectedFlags)
      throw invalid(errorText("main.refHistory.indexFlagsChangedSinceThisAction"));
  }

  if (
    !options.pendingConfiguration &&
    operation.kind === "branch-rename" &&
    operation.beforeFromConfig &&
    operation.afterFromConfig &&
    operation.from
  ) {
    const config = await branchConfiguration(git, record.root, operation.from);

    if (
      JSON.stringify(config) !==
      JSON.stringify(undo ? operation.afterFromConfig : operation.beforeFromConfig)
    )
      throw invalid(
        errorText("main.refHistory.branchConfigurationChangedSinceThisActionInspectThe"),
      );
  }

  if (
    !options.pendingConfiguration &&
    operation.beforeConfig &&
    operation.afterConfig &&
    operation.to
  ) {
    const config = await branchConfiguration(git, record.root, operation.to);

    if (
      JSON.stringify(config) !==
      JSON.stringify(undo ? operation.afterConfig : operation.beforeConfig)
    )
      throw invalid(
        errorText("main.refHistory.branchConfigurationChangedSinceThisActionInspectThe"),
      );
  }

  if (
    (operation.kind === "branch-create" && undo) ||
    (operation.kind === "branch-delete" && !undo)
  ) {
    const worktrees = await git.exec(["worktree", "list", "--porcelain"], {
      cwd: record.root,
      operation: t("operations.protectCheckedOutBranchBeforeReversal"),
    });
    const checkouts = worktrees.stdout
      .split("\n")
      .filter((line) => line === `branch refs/heads/${operation.to}`).length;
    const allowed = operation.kind === "branch-create" && operation.checkedOut ? 1 : 0;

    if (checkouts > allowed)
      throw invalid(errorText("main.refHistory.theBranchIsCheckedOutInAnotherWorktree"));
  }

  await checkoutState(
    git,
    record.root,
    undo ? operation.afterBranch : operation.beforeBranch,
    undo ? operation.afterHead : operation.beforeHead,
  );

  const pendingRename = options.pendingConfiguration && operation.kind === "branch-rename";
  const status = await git.status(record.root);
  const fingerprint = await workflowFingerprint(
    git,
    record.root,
    pendingRename ? status.changes : status,
  );

  if (
    fingerprint !==
    (pendingRename
      ? operation.startContentFingerprint
      : undo
        ? operation.afterFingerprint
        : operation.beforeFingerprint)
  )
    throw invalid(errorText("main.refHistory.theRepositoryChangedSinceThisReferenceActionUndo"));

  if (record.branch) {
    const worktrees = await git.exec(["worktree", "list", "--porcelain"], {
      cwd: record.root,
      operation: t("operations.validateReferenceWorktrees"),
    });

    if (
      worktrees.stdout.split("\n").filter((line) => line === `branch refs/heads/${record.branch}`)
        .length > 1
    )
      throw invalid(errorText("main.refHistory.thisBranchIsCheckedOutInMultipleWorktrees"));
  }

  if (operation.kind === "branch-create") {
    const current = await branchTip(git, record.root, operation.to!);
    if (undo ? current !== operation.tip : current !== null)
      throw invalid(errorText("main.refHistory.theCreatedBranchChangedSinceThisAction"));
  } else if (operation.kind === "branch-delete") {
    const current = await branchTip(git, record.root, operation.to!);
    if (undo ? current !== null : current !== operation.tip)
      throw invalid(errorText("main.refHistory.theDeletedBranchReferenceChangedSinceThisAction"));
  } else if (operation.kind === "branch-rename") {
    const from = await branchTip(git, record.root, operation.from!);
    const to = await branchTip(git, record.root, operation.to!);
    if (undo ? from !== null || to !== operation.tip : from !== operation.tip || to !== null)
      throw invalid(errorText("main.refHistory.theRenamedBranchReferencesChangedSinceThisAction"));
  }

  return undo ? "undo" : "redo";
}

export async function validateUnstartedRefIntent(git: GitService, record: WorkflowJournalRecord) {
  if (!record.refOperation || record.state === "completed" || record.refOperation.afterFingerprint)
    throw invalid(
      errorText("main.refHistory.onlyAnUnfinishedOriginalReferenceActionCanBeDismissed"),
    );

  const candidate = structuredClone(record);

  candidate.state = "completed";
  candidate.refOperation!.state = "undone";
  delete candidate.refOperation!.blockedReason;
  delete candidate.refOperation!.recoveryRef;
  await validateRefHistory(git, candidate);
}

export async function validatePendingBranchCheckout(
  git: GitService,
  record: WorkflowJournalRecord,
) {
  const operation = record.refOperation;

  if (
    !operation ||
    record.state === "completed" ||
    operation.afterFingerprint ||
    operation.kind !== "branch-create" ||
    !operation.checkedOut ||
    !operation.to ||
    operation.beforeIndexFlags === undefined ||
    !operation.afterConfig
  )
    throw invalid(errorText("main.refHistory.thisActionHasNoInterruptedOriginalBranchCheckout"));

  const candidate = structuredClone(record);

  candidate.state = "completed";

  const expected = candidate.refOperation!;

  expected.state = "applied";
  expected.afterHead = operation.beforeHead;
  expected.afterBranch = operation.beforeBranch;
  expected.afterFingerprint = operation.beforeFingerprint;
  expected.afterIndexFlags = operation.beforeIndexFlags;
  await validateRefHistory(git, candidate);
}

export async function finishBranchCheckout(git: GitService, record: WorkflowJournalRecord) {
  await validatePendingBranchCheckout(git, record);
  await git.exec(["checkout", "--no-overwrite-ignore", record.refOperation!.to!, "--"], {
    cwd: record.root,
    operation: t("operations.resumeOriginalBranchCheckout"),
  });

  const candidate = structuredClone(record);

  candidate.refOperation!.afterFingerprint = await workflowFingerprint(
    git,
    record.root,
    await git.status(record.root),
  );
  candidate.refOperation!.afterIndexFlags = (
    await git.exec(["ls-files", "-v", "-z"], {
      cwd: record.root,
      operation: t("operations.captureResumedCheckoutFlags"),
    })
  ).stdout;

  return completedRefIntent(git, candidate);
}

export async function pendingBranchReversal(git: GitService, record: WorkflowJournalRecord) {
  const operation = record.refOperation;

  if (
    !operation ||
    record.state !== "completed" ||
    operation.kind !== "branch-create" ||
    !operation.checkedOut ||
    !["undoing", "redoing"].includes(operation.state) ||
    !operation.beforeConfig ||
    !operation.afterConfig ||
    operation.beforeIndexFlags === undefined
  )
    throw invalid(errorText("main.refHistory.thisActionHasNoPartialBranchCreationReversal"));

  const direction = operation.state === "undoing" ? "undo" : "redo";
  const candidate = structuredClone(record);
  const expected = candidate.refOperation!;

  expected.state = "applied";
  expected.afterHead = operation.beforeHead;
  expected.afterBranch = operation.beforeBranch;
  expected.afterFingerprint = operation.beforeFingerprint;
  expected.afterIndexFlags = operation.beforeIndexFlags;
  expected.afterConfig = direction === "undo" ? operation.afterConfig : operation.beforeConfig;
  expected.checkedOut = false;
  await validateRefHistory(git, candidate);

  return direction;
}

export async function finishBranchReversal(
  git: GitService,
  record: WorkflowJournalRecord,
  direction: HistoryDirection,
) {
  if ((await pendingBranchReversal(git, record)) !== direction)
    throw invalid(errorText("main.refHistory.theInterruptedDirectionChangedRefreshUndoRedo"));

  const operation = record.refOperation!;
  const undo = direction === "undo";

  await withBranchConfiguration(
    git,
    record.root,
    operation.to!,
    (undo ? operation.afterConfig : operation.beforeConfig)!,
    (undo ? operation.beforeConfig : operation.afterConfig)!,
    async () => {
      await pendingBranchReversal(git, record);

      if (undo)
        await git.exec(
          [
            "update-ref",
            "--no-deref",
            "-m",
            "Eda: finish undo create branch",
            "-d",
            `refs/heads/${operation.to}`,
            operation.tip!,
          ],
          {
            cwd: record.root,
            operation: t("operations.resumeBranchReversal"),
          },
        );
      else
        await git.exec(["checkout", "--no-overwrite-ignore", operation.to!, "--"], {
          cwd: record.root,
          operation: t("operations.resumeBranchReversal"),
        });
    },
  );

  const candidate = structuredClone(record);

  candidate.refOperation!.state = undo ? "undone" : "applied";
  await validateRefHistory(git, candidate);

  return candidate;
}

export async function completedRefIntent(git: GitService, record: WorkflowJournalRecord) {
  const operation = record.refOperation;

  if (!operation || record.state === "completed")
    throw invalid(errorText("main.refHistory.thisActionHasNoUnfinishedOriginalRecord"));

  const candidate = structuredClone(record);
  const next = candidate.refOperation!;
  const status = await git.status(record.root);

  if (!operation.afterFingerprint) {
    const flags = (
      await git.exec(["ls-files", "-v", "-z"], {
        cwd: record.root,
        operation: t("operations.inspectInterruptedReferenceIndexFlags"),
      })
    ).stdout;

    const changesCheckout =
      operation.kind === "checkout" || (operation.kind === "branch-create" && operation.checkedOut);

    if (changesCheckout) {
      if (!operation.cleanStart || status.changes.length || hasSpecialIndexFlags(flags))
        throw invalid(
          errorText("main.refHistory.thisInterruptedCheckoutHasLocalChangesInspectThe"),
        );
    }

    const contents = await readWorkflowContents(git, record.root);
    if (
      !changesCheckout &&
      (operation.startContentFingerprint !== fingerprintContents(status.changes, contents) ||
        flags !== operation.beforeIndexFlags)
    )
      throw invalid(
        errorText("main.refHistory.repositoryContentsChangedDuringThisActionPreserveNewer"),
      );

    next.afterFingerprint = fingerprintContents(status, contents);
    next.afterIndexFlags = flags;
  }

  candidate.state = "completed";
  next.state = "applied";
  await validateRefHistory(git, candidate);

  return candidate;
}

export async function pendingRefConfiguration(git: GitService, record: WorkflowJournalRecord) {
  const operation = record.refOperation;

  if (
    !operation ||
    !["undoing", "redoing"].includes(operation.state) ||
    !operation.beforeConfig ||
    !operation.afterConfig ||
    !operation.to
  )
    throw invalid(
      errorText("main.refHistory.thisActionHasNoInterruptedBranchConfigurationToRestore"),
    );

  const undo = operation.state === "undoing";
  const candidate = structuredClone(record);

  candidate.refOperation!.state = undo ? "undone" : "applied";
  await validateRefHistory(git, candidate, { pendingConfiguration: true });

  if (operation.kind === "branch-rename") {
    if (!operation.from || !operation.beforeFromConfig || !operation.afterFromConfig)
      throw invalid(errorText("main.refHistory.theRenameHasNoCompleteSettingsSnapshot"));

    const moved = (entries: [string, string][], name: string): [string, string][] =>
      entries.map(([key, value]) => [
        `branch.${name}.${key.slice(key.lastIndexOf(".") + 1)}`,
        value,
      ]);
    const endpoints = undo
      ? [
          {
            name: operation.from,
            source: moved(operation.afterConfig, operation.from),
            target: operation.beforeFromConfig,
          },
          { name: operation.to, source: [], target: operation.beforeConfig },
        ]
      : [
          { name: operation.from, source: [], target: operation.afterFromConfig },
          { name: operation.to, source: operation.afterConfig, target: operation.afterConfig },
        ];

    const changes = [];

    for (const endpoint of endpoints) {
      const current = await branchConfiguration(git, record.root, endpoint.name);

      if (
        JSON.stringify(current) !== JSON.stringify(endpoint.source) &&
        JSON.stringify(current) !== JSON.stringify(endpoint.target)
      )
        throw invalid(
          errorText("main.refHistory.branchConfigurationHasNewerSettingsPreserveThemBeforeMessage"),
        );

      changes.push({ name: endpoint.name, expected: current, target: endpoint.target });
    }

    return { candidate, changes };
  }

  const source = undo ? operation.afterConfig : operation.beforeConfig;
  const target = undo ? operation.beforeConfig : operation.afterConfig;
  const current = await branchConfiguration(git, record.root, operation.to);

  if (
    JSON.stringify(current) !== JSON.stringify(source) &&
    JSON.stringify(current) !== JSON.stringify(target)
  )
    throw invalid(
      errorText("main.refHistory.branchConfigurationHasNewerSettingsPreserveThemBefore"),
    );

  return { candidate, changes: [{ name: operation.to, expected: current, target }] };
}

export async function finishRefConfiguration(git: GitService, record: WorkflowJournalRecord) {
  const { candidate, changes } = await pendingRefConfiguration(git, record);
  await withBranchConfigurations(git, record.root, changes, async () => {
    await validateRefHistory(git, candidate, { pendingConfiguration: true });
  });
  await validateRefHistory(git, candidate);
  return candidate;
}

export async function executeRefHistory(
  git: GitService,
  record: WorkflowJournalRecord,
  direction: HistoryDirection,
): Promise<void> {
  const operation = record.refOperation!;

  if (
    operation.kind === "branch-rename" &&
    direction === "undo" &&
    operation.beforeConfig?.length
  ) {
    await git.exec(["branch", "-m", operation.to!, operation.from!], {
      cwd: record.root,
      operation: t("operations.undoBranchRename"),
    });
    await finishRefConfiguration(git, record);
    return;
  }

  if (
    operation.kind !== "branch-rename" &&
    operation.beforeConfig &&
    operation.afterConfig &&
    operation.to
  ) {
    const undo = direction === "undo";

    return withBranchConfiguration(
      git,
      record.root,
      operation.to,
      undo ? operation.afterConfig : operation.beforeConfig,
      undo ? operation.beforeConfig : operation.afterConfig,
      () => executeRefChanges(git, record, direction),
    );
  }

  return executeRefChanges(git, record, direction);
}

async function executeRefChanges(
  git: GitService,
  record: WorkflowJournalRecord,
  direction: HistoryDirection,
): Promise<void> {
  const operation = record.refOperation!;
  const undo = direction === "undo";
  const root = record.root;
  const soft = {
    cwd: root,
    operation: `${direction} ${operation.kind}`,
  };
  const ref = (name: string) => `refs/heads/${name}`;

  if (operation.kind === "branch-create") {
    if (undo) {
      if (operation.checkedOut && operation.beforeBranch)
        await git.exec(["checkout", "--no-overwrite-ignore", operation.beforeBranch, "--"], soft);
      else if (operation.checkedOut && operation.beforeHead)
        await git.exec(
          ["checkout", "--no-overwrite-ignore", "--detach", operation.beforeHead, "--"],
          soft,
        );

      await git.exec(
        [
          "update-ref",
          "--no-deref",
          "-m",
          "Eda: undo create branch",
          "-d",
          ref(operation.to!),
          operation.tip!,
        ],
        soft,
      );
    } else {
      await git.exec(
        [
          "update-ref",
          "--no-deref",
          "-m",
          "Eda: redo create branch",
          ref(operation.to!),
          operation.tip!,
          "",
        ],
        soft,
      );

      if (operation.checkedOut)
        await git.exec(["checkout", "--no-overwrite-ignore", operation.to!, "--"], soft);
    }
  } else if (operation.kind === "branch-delete") {
    if (undo)
      await git.exec(
        [
          "update-ref",
          "--no-deref",
          "-m",
          "Eda: undo delete branch",
          "--create-reflog",
          ref(operation.to!),
          operation.tip!,
          "",
        ],
        soft,
      );
    else
      await git.exec(
        [
          "update-ref",
          "--no-deref",
          "-m",
          "Eda: redo delete branch",
          "-d",
          ref(operation.to!),
          operation.tip!,
        ],
        soft,
      );
  } else if (operation.kind === "branch-rename") {
    await git.exec(
      [
        "branch",
        "-m",
        undo ? operation.to! : operation.from!,
        undo ? operation.from! : operation.to!,
      ],
      soft,
    );
  } else {
    const branch = undo ? operation.beforeBranch : operation.afterBranch;
    const head = undo ? operation.beforeHead : operation.afterHead;
    if (branch) await git.exec(["checkout", "--no-overwrite-ignore", branch, "--"], soft);
    else if (head)
      await git.exec(["checkout", "--no-overwrite-ignore", "--detach", head, "--"], soft);
    else
      throw invalid(errorText("main.refHistory.theRecordedCheckoutHasNoBranchOrCommitToRestore"));
  }

  await checkoutState(
    git,
    root,
    undo ? operation.beforeBranch : operation.afterBranch,
    undo ? operation.beforeHead : operation.afterHead,
  );

  if (operation.kind === "branch-create") {
    const tip = await branchTip(git, root, operation.to!);
    if ((direction === "undo" && tip !== null) || (direction === "redo" && tip !== operation.tip))
      throw invalid(
        errorText("main.refHistory.theReferenceReversalDidNotFinishInTheRecordedState"),
      );
  } else if (operation.kind === "branch-delete") {
    const tip = await branchTip(git, root, operation.to!);
    if ((direction === "undo" && tip !== operation.tip) || (direction === "redo" && tip !== null))
      throw invalid(
        errorText("main.refHistory.theReferenceReversalDidNotFinishInTheRecordedState"),
      );
  } else if (operation.kind === "branch-rename") {
    const expected = direction === "undo" ? operation.from! : operation.to!;
    if ((await branchTip(git, root, expected)) !== operation.tip)
      throw invalid(
        errorText("main.refHistory.theReferenceReversalDidNotFinishInTheRecordedState"),
      );
  }

  const fingerprint = await workflowFingerprint(git, root, await git.status(root));

  if (fingerprint !== (undo ? operation.beforeFingerprint : operation.afterFingerprint))
    throw invalid(errorText("main.refHistory.theReferenceReversalDidNotFinishInThe"));

  if (operation.kind === "branch-rename") {
    const candidate = structuredClone(record);
    candidate.refOperation!.state = undo ? "undone" : "applied";
    await validateRefHistory(git, candidate);
  }
}
