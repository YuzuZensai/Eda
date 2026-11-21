import { isUtf8 } from "node:buffer";
import { AppError, GitError } from "@shared/errors";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import { readLfsPointer } from "@shared/repository/lfs-pointer";
import { unquotePath } from "../parsers/diff-parser";
import type {
  BlameLine,
  BlameRequest,
  RevisionPath,
  RevisionPathRequest,
} from "@shared/repository/repository-read";
import type { GitService } from "../git-service";
import { assertFullObjectId, assertRepositoryPath } from "../validation";

export async function readRevisionPath(
  git: Pick<GitService, "exec">,
  cwd: string,
  { oid, path }: RevisionPathRequest,
): Promise<RevisionPath> {
  const operation = t("revision.browse");
  assertFullObjectId(oid, operation);
  if (path !== undefined) assertRepositoryPath(path, operation);
  const object = oid + ":" + (path ?? "");
  const options = { cwd, operation, maxStdoutBytes: 128 };
  const { stdout } = await git.exec(["cat-file", "-t", object], options);
  if (stdout.trim() === "tree") {
    const result = await git.exec(["ls-tree", "-z", object], {
      ...options,
      maxStdoutBytes: 4 * 1024 * 1024,
    });
    if (!isUtf8(result.stdoutBytes))
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText("main.git.gitService.invalidComparisonPathEncoding"),
      });
    const entries = result.stdout.split("\0");
    entries.pop();
    return {
      kind: "tree",
      entries: entries.map((line) => {
        const match = /^\d+ (tree|blob|commit) ([0-9a-f]+)\t(.+)$/s.exec(line);
        const type = match?.[1];
        if (!match || (type !== "tree" && type !== "blob" && type !== "commit"))
          throw new AppError(ERROR_CODE.INVALID_GIT_OUTPUT);
        return { name: match[3]!, type, oid: match[2]! };
      }),
    };
  }
  if (stdout.trim() !== "blob") throw new AppError(ERROR_CODE.INVALID_GIT_OUTPUT);
  const bytes = Number((await git.exec(["cat-file", "-s", object], options)).stdout.trim());
  const limit = 512 * 1024;
  if (bytes > limit) return { kind: "large", bytes };
  const data = await git.exec(["cat-file", "blob", object], { ...options, maxStdoutBytes: limit });
  if (data.stdoutBytes.includes(0) || !isUtf8(data.stdoutBytes)) return { kind: "binary", bytes };
  const text = data.stdoutBytes.toString("utf8");
  const lfs = readLfsPointer(text);
  return { kind: "text", text, ...(lfs && { lfs }) };
}

export async function readBlame(
  git: Pick<GitService, "exec">,
  cwd: string,
  { oid, path, start }: BlameRequest,
): Promise<BlameLine[]> {
  const operation = t("revision.blame");
  assertFullObjectId(oid, operation);
  assertRepositoryPath(path, operation);
  const { stdout } = await git.exec(
    [
      "-c",
      "core.quotePath=false",
      "blame",
      "--line-porcelain",
      "--no-textconv",
      "-L",
      String(start) + ",+100",
      oid,
      "--",
      path,
    ],
    { cwd, operation, maxStdoutBytes: 4 * 1024 * 1024 },
  );
  const results: BlameLine[] = [];
  let current: BlameLine | undefined;
  for (const line of stdout.split("\n")) {
    const header = /^([a-f0-9]{40}|[a-f0-9]{64}) \d+ \d+(?: \d+)?$/.exec(line);
    if (header) current = { oid: header[1]!, author: "", text: "" };
    else if (current && line.startsWith("author ")) current.author = line.slice(7);
    else if (current && line.startsWith("previous ")) {
      const previous = /^previous ([a-f0-9]+) (.+)$/.exec(line);
      if (previous) current.previous = { oid: previous[1]!, path: unquotePath(previous[2]!) };
    } else if (current && line.startsWith("\t")) {
      current.text = line.slice(1);
      results.push(current);
      current = undefined;
    }
  }
  return results;
}
