import { isFullObjectId } from "@shared/repository/object-id";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { stateLabel } from "@shared/i18n/labels";
import {
  RECOVERY_PAGE_SIZE,
  type RecoveryEntry,
  type RecoveryInspection,
  type RecoveryPage,
  type RecoverySource,
} from "@shared/workflows/history-recovery";
import { createHash, randomUUID } from "node:crypto";
import { readWorkflowState } from "../../git/operations/workflow-state";

import type { GitService } from "../../git/git-service";
import { assertFullObjectId, assertValidRefName } from "../../git/validation";
import type { WorkflowJournal } from "../../persistence/workflow-journal";
import { PreviewStore } from "../preview-store";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import type { RepositoryWriter } from "../working-tree/repository-writer";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.recoverHistory"), message });

export class HistoryRecoveryService {
  private readonly inspections = new PreviewStore<{
    repositoryId: string;
    profileId: string;
    root: string;
    oid: string;
  }>();

  private readonly cleanups = new PreviewStore<{
    repositoryId: string;
    profileId: string;
    root: string;
    fingerprint: string;
  }>();

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly writer: RepositoryWriter,
    private readonly journal: WorkflowJournal,
  ) {}

  async list(repositoryId: string, source: RecoverySource, offset = 0): Promise<RecoveryPage> {
    const { path, identityId } = this.repositories.resolveActiveRepository(repositoryId);

    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
      throw invalid(errorText("main.historyRecoveryService.invalidPage"));

    let entries: RecoveryEntry[];
    let cleanup: RecoveryPage["cleanup"];

    if (source === "rewrites") {
      entries = this.journal
        .publishedRewrites(identityId, repositoryId, path, offset, RECOVERY_PAGE_SIZE + 1)
        .map((record) => ({
          oid: record.head || record.publishedReversal!.fromHead,
          label: record.message,
          description: t("main.historyRecoveryService.publishedAction", {
            updatedAt: record.updatedAt,
            value2: record.branch ?? t("main.historyRecoveryService.detachedHead"),
            state: stateLabel(record.state),
            value4: record.refChange?.reversal
              ? ` / ${stateLabel(record.refChange.reversal.state)}`
              : "",
            value5: record.publishedCommits ?? 0,
            value6:
              record.refChange?.afterHead ??
              record.resultHead ??
              t("main.historyRecoveryService.notRecorded"),
            value7: record.publishedReversal
              ? t("main.historyRecoveryService.latestReversal", {
                  direction: stateLabel(record.publishedReversal.direction),
                  recordedAt: record.publishedReversal.recordedAt,
                  count: record.publishedReversal.count,
                  fromHead: record.publishedReversal.fromHead,
                  value5:
                    record.publishedReversal.toHead ||
                    t("main.historyRecoveryService.unbornBranch"),
                })
              : "",
          }),
        }));
    } else if (source === "reflog") {
      const result = await this.git.exec(
        [
          "log",
          "--walk-reflogs",
          "--exclude=refs/eda/*",
          "--all",
          "--no-patch",
          "--no-decorate",
          "-z",
          `--skip=${offset}`,
          `--max-count=${RECOVERY_PAGE_SIZE + 1}`,
          "--format=%H%x00%gD%x00%gs",
        ],
        { cwd: path, operation: t("operations.browseReflogs"), maxStdoutBytes: 4 * 1024 * 1024 },
      );

      const fields = result.stdout.split("\0");

      entries = [];

      for (let i = 0; i + 2 < fields.length; i += 3) {
        const oid = fields[i]!.trim();
        if (!isFullObjectId(oid))
          throw invalid(errorText("main.historyRecoveryService.invalidReflog"));
        entries.push({ oid, label: fields[i + 1]!, description: fields[i + 2]! });
      }
    } else if (source === "saved") {
      const result = await this.git.exec(
        [
          "for-each-ref",
          "--sort=-creatordate",
          "--format=%(objectname)%00%(refname)%00%(objecttype)%00%(subject)",
          "refs/eda/recovery",
          "refs/eda/reference",
        ],
        {
          cwd: path,
          operation: t("operations.browseSavedRecoveryRefs"),
          maxStdoutBytes: 4 * 1024 * 1024,
        },
      );

      entries = result.stdout
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const [oid, label, type, description] = line.split("\0");
          return type === "commit" && oid && label
            ? [{ oid, label, description: description ?? "" }]
            : [];
        })
        .slice(offset, offset + RECOVERY_PAGE_SIZE + 1);
    } else if (source === "unreachable" || source === "dangling") {
      const scan = await this.scanUnreachable(path, source === "unreachable");
      entries = scan.oids.slice(offset, offset + RECOVERY_PAGE_SIZE + 1).map((oid) => ({
        oid,
        label: t("main.historyRecoveryService.unreachableCommit"),
        description: t("main.historyRecoveryService.inspectHint"),
      }));

      if (source === "dangling") {
        const token = randomUUID();
        this.cleanups.set(token, {
          repositoryId,
          profileId: identityId,
          root: path,
          fingerprint: scan.fingerprint,
        });
        cleanup = { token, count: scan.oids.length };

        if (entries.length) {
          const subjects = await this.git.exec(
            ["log", "--no-walk=unsorted", "--format=%H%x00%s", "--stdin"],
            {
              cwd: path,
              operation: t("operations.scanUnreachableCommits"),
              stdin: entries.map((entry) => entry.oid).join("\n") + "\n",
              maxStdoutBytes: 4 * 1024 * 1024,
            },
          );
          const labels = new Map(
            subjects.stdout
              .trimEnd()
              .split("\n")
              .map((line) => {
                const separator = line.indexOf("\0");
                return [line.slice(0, separator), line.slice(separator + 1)];
              }),
          );
          entries = entries.map((entry) => ({
            ...entry,
            label: labels.get(entry.oid) ?? entry.label,
            description: "",
          }));
        }
      }
    } else throw invalid(errorText("main.historyRecoveryService.invalidSource"));

    const hasMore = entries.length > RECOVERY_PAGE_SIZE;

    return {
      ...(cleanup && { cleanup }),
      entries: entries.slice(0, RECOVERY_PAGE_SIZE),
      nextOffset: hasMore ? offset + RECOVERY_PAGE_SIZE : null,
    };
  }

  private async scanUnreachable(root: string, ignoreReflogs = false) {
    // A stale commit-graph cache can reference pruned commits; scan the actual objects.
    const result = await this.git.exec(
      [
        "-c",
        "core.commitGraph=false",
        "fsck",
        "--unreachable",
        "--no-progress",
        ...(ignoreReflogs ? ["--no-reflogs"] : []),
      ],
      {
        cwd: root,
        operation: t("operations.scanUnreachableCommits"),
        maxStdoutBytes: 4 * 1024 * 1024,
      },
    );
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    const oids = lines.flatMap((line) => {
      const match = /^unreachable commit (\S+)$/.exec(line);
      return match && isFullObjectId(match[1]) ? [match[1]!] : [];
    });

    return { oids, fingerprint: createHash("sha256").update(lines.join("\n")).digest("hex") };
  }

  clearDangling(repositoryId: string, token: string): Promise<void> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const review = this.cleanups.get(token);
    const stale = () => invalid(errorText("main.historyRecoveryService.cleanupChanged"));

    if (
      !review ||
      review.repositoryId !== repositoryId ||
      review.profileId !== repository.identityId ||
      review.root !== repository.path
    )
      throw stale();

    return this.writer.remoteOperation(
      repositoryId,
      t("operations.clearDanglingCommits"),
      async (root, identity) => {
        if (root !== review.root || identity.id !== review.profileId || !this.cleanups.get(token))
          throw stale();
        if (await readWorkflowState(this.git, root, await this.git.status(root)))
          throw invalid(errorText("main.historyRecoveryService.cleanupWorkflow"));

        const current = await this.scanUnreachable(root);
        if (current.fingerprint !== review.fingerprint) throw stale();
        this.cleanups.delete(token);

        if (!current.oids.length) return;
        await this.git.exec(["repack", "-A", "-d", "-l"], {
          cwd: root,
          operation: t("operations.clearDanglingCommits"),
        });
        await this.git.exec(["prune", "--expire=now"], {
          cwd: root,
          operation: t("operations.clearDanglingCommits"),
        });
      },
    );
  }

  async inspect(repositoryId: string, oid: string): Promise<RecoveryInspection> {
    assertFullObjectId(oid, t("operations.inspectRecoveryCommit"));

    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const inspection = await this.git.inspectCommit(repository.path, oid);

    if (inspection.commit.oid !== oid)
      throw invalid(errorText("main.historyRecoveryService.invalidCommit"));

    let diff: RecoveryInspection["diff"] = { files: [] };
    let diffNotice: string | undefined;

    try {
      diff = await this.git.commitDiff(repository.path, oid);
    } catch (error) {
      if (!(error instanceof GitError) || error.kind !== "output-too-large") throw error;
      diffNotice = t("main.historyRecoveryService.largeDiff");
    }

    const token = randomUUID();

    this.inspections.set(token, {
      repositoryId,
      profileId: repository.identityId,
      root: repository.path,
      oid,
    });

    return { token, inspection, diff, ...(diffNotice ? { diffNotice } : {}) };
  }

  restore(repositoryId: string, token: string, name: string): Promise<string> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const review = this.inspections.get(token);

    if (
      !review ||
      review.repositoryId !== repositoryId ||
      review.profileId !== repository.identityId ||
      review.root !== repository.path
    )
      throw invalid(errorText("main.historyRecoveryService.expiredInspection"));

    assertValidRefName(name, t("operations.restoreRecoveredBranch"));

    return this.writer.remoteOperation(
      repositoryId,
      t("main.historyRecoveryService.restoreRecoveredBranch"),
      async (root, identity) => {
        await this.git.exec(["check-ref-format", "--branch", name], {
          cwd: root,
          operation: t("operations.validateRecoveredBranchName"),
        });

        const resolved = await this.git.exec(["rev-parse", "--verify", `${review.oid}^{commit}`], {
          cwd: root,
          operation: t("operations.validateRecoveredCommit"),
        });

        if (resolved.stdout.trim() !== review.oid)
          throw invalid(errorText("main.historyRecoveryService.missingCommit"));

        await this.git.exec(
          [
            "update-ref",
            "--no-deref",
            "--create-reflog",
            "-m",
            "Eda: restore inspected commit",
            "--stdin",
          ],
          {
            cwd: root,
            operation: t("operations.restoreRecoveredBranch"),
            stdin: `create refs/heads/${name} ${review.oid}\n`,
            env: {
              overrides: {
                GIT_COMMITTER_NAME: identity.gitName,
                GIT_COMMITTER_EMAIL: identity.gitEmail,
              },
            },
          },
        );
        this.inspections.delete(token);

        return `refs/heads/${name}`;
      },
    );
  }
}
