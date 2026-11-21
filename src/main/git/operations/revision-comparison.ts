import { isUtf8 } from "node:buffer";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import { AppError, GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { MAX_DIFF_FILES } from "@shared/repository/diff-limits";
import type {
  ComparisonFile,
  RevisionComparison,
  RevisionComparisonRequest,
} from "@shared/repository/repository-read";
import type { GitService } from "../git-service";
import { mapGitError } from "../execution/error-mapping";
import { assertFullObjectId, assertValidRefName } from "../validation";

const STATUSES = new Map<string, ComparisonFile["status"]>([
  ["A", "added"],
  ["D", "deleted"],
  ["M", "modified"],
  ["T", "type-changed"],
  ["R", "renamed"],
  ["C", "copied"],
]);

function comparisonFiles(output: string): Pick<RevisionComparison, "files" | "omittedFiles"> {
  const files: ComparisonFile[] = [];
  let omittedFiles = 0;
  let offset = 0;

  const readField = () => {
    const end = output.indexOf("\0", offset);
    if (end <= offset) throw new AppError(ERROR_CODE.INVALID_DIFF_OUTPUT);
    const field = output.slice(offset, end);
    offset = end + 1;
    return field;
  };

  while (offset < output.length) {
    const status = STATUSES.get(readField().charAt(0));
    if (!status) throw new AppError(ERROR_CODE.INVALID_DIFF_OUTPUT);

    const path = readField();
    const newPath = status === "renamed" || status === "copied" ? readField() : path;
    if (files.length < MAX_DIFF_FILES) {
      files.push({
        status,
        ...(status !== "added" && { oldPath: path }),
        ...(status !== "deleted" && { newPath }),
      });
    } else {
      omittedFiles++;
    }
  }

  return { files, omittedFiles };
}

export async function readRevisionComparison(
  git: Pick<GitService, "exec">,
  cwd: string,
  { left, right, mode }: RevisionComparisonRequest,
): Promise<RevisionComparison> {
  const operation = t("operations.compareRevisions");
  const options = { cwd, operation, maxStdoutBytes: 1024, maxStderrBytes: 64 * 1024 };
  for (const revision of [left, right]) {
    // Permit Git's parent and ancestor suffixes on a single named revision.
    const name = revision.replace(/(?:[~^]\d*)+$/, "");
    assertValidRefName(name, operation);
  }

  const resolveCommit = async (revision: string) => {
    const result = await git.exec(
      [
        "-c",
        "core.warnAmbiguousRefs=true",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${revision}^{commit}`,
      ],
      { ...options, allowedExitCodes: [0, 128] },
    );
    if (result.stderr.includes(" is ambiguous"))
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText("main.git.gitService.ambiguousComparisonRevision", { revision }),
      });
    if (result.exitCode !== 0) {
      const error = mapGitError({ ...result, repositoryPath: cwd, operation });
      if (error.kind !== "unknown") throw error;
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText("main.git.gitService.theCommitIsNoLongerAvailable"),
        suggestedAction: errorText(
          "main.git.gitService.refreshReferencesAndSelectAnAvailableCommit",
        ),
        rawStderr: result.stderr,
      });
    }
    const oid = result.stdout.trim();
    assertFullObjectId(oid, operation);
    return oid;
  };

  const [leftOid, rightOid] = await Promise.all([resolveCommit(left), resolveCommit(right)]);
  let baseOid = leftOid;

  if (mode === "merge-base") {
    const base = await git.exec(["merge-base", leftOid, rightOid], {
      ...options,
      allowedExitCodes: [0, 1],
    });
    if (base.exitCode === 1)
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText("main.git.gitService.noCommonAncestor"),
        suggestedAction: errorText("main.git.gitService.chooseDirectComparison"),
      });
    baseOid = base.stdout.trim();
    assertFullObjectId(baseOid, operation);
  }

  const result = await git.exec(
    [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--no-ext-diff",
      "--no-textconv",
      baseOid,
      rightOid,
      "--",
    ],
    { ...options, maxStdoutBytes: 4 * 1024 * 1024 },
  );
  if (!isUtf8(result.stdoutBytes))
    throw new GitError({
      kind: "invalid-input",
      operation,
      message: errorText("main.git.gitService.invalidComparisonPathEncoding"),
    });

  return { leftOid, rightOid, baseOid, ...comparisonFiles(result.stdout) };
}
