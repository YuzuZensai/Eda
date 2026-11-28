import { isFullObjectId } from "@shared/repository/object-id";
import { ERROR_CODE } from "@shared/error-codes";
import { AppError } from "@shared/errors";
import type {
  ChangeCode,
  RepositoryBranchStatus,
  RepositoryChange,
  RepositoryStatus,
} from "@shared/repository/repository-read";

const CHANGE_CODES = new Set<ChangeCode>([".", "M", "T", "A", "D", "R", "C", "U", "?", "!"]);

export function parseStatus(output: Buffer): RepositoryStatus {
  const records = output.toString("utf8").split("\0");

  if (records.at(-1) === "") records.pop();

  const branch: RepositoryBranchStatus = { ahead: 0, behind: 0, detached: false, unborn: false };
  const changes: RepositoryChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;

    if (record.startsWith("# ")) {
      parseBranchHeader(record, branch);
      continue;
    }

    if (record.startsWith("1 ")) {
      changes.push(parseOrdinary(record));
      continue;
    }

    if (record.startsWith("2 ")) {
      const originalPath = records[index + 1];
      if (originalPath === undefined) malformed();
      changes.push(parseRename(record, originalPath));
      index += 1;
      continue;
    }

    if (record.startsWith("u ")) {
      changes.push(parseUnmerged(record));
      continue;
    }

    if (record.startsWith("? ") || record.startsWith("! ")) {
      const code = record[0] as "?" | "!";
      const path = record.slice(2);

      if (path.length === 0) malformed();

      changes.push({
        kind: code === "?" ? "untracked" : "ignored",
        path,
        index: code,
        worktree: code,
        submodule: "N...",
      });
      continue;
    }

    malformed();
  }

  return { branch, changes };
}

function parseBranchHeader(record: string, branch: RepositoryBranchStatus): void {
  const separator = record.indexOf(" ", 2);

  if (separator < 0) malformed();

  const key = record.slice(2, separator);
  const value = record.slice(separator + 1);

  if (key === "branch.oid") {
    if (value === "(initial)") branch.unborn = true;
    else {
      assertOid(value);
      branch.oid = value;
    }
  } else if (key === "branch.head") {
    if (value === "(detached)") branch.detached = true;
    else branch.head = value;
  } else if (key === "branch.upstream") {
    branch.upstream = value;
  } else if (key === "branch.ab") {
    const match = /^\+(\d+) -(\d+)$/.exec(value);
    if (!match) malformed();
    branch.ahead = Number(match[1]);
    branch.behind = Number(match[2]);
  }
}

function parseOrdinary(record: string): RepositoryChange {
  const fields = record.split(" ");

  if (fields.length < 9) malformed();

  const [index, worktree] = parseXy(fields[1]);
  const headOid = fields[6]!;
  const indexOid = fields[7]!;

  assertOid(headOid);
  assertOid(indexOid);

  return {
    kind: "ordinary",
    path: fields.slice(8).join(" "),
    index,
    worktree,
    submodule: fields[2]!,
    headOid,
    indexOid,
  };
}

function parseRename(record: string, originalPath: string): RepositoryChange {
  const fields = record.split(" ");

  if (fields.length < 10 || originalPath.length === 0) malformed();

  const [index, worktree] = parseXy(fields[1]);
  const headOid = fields[6]!;
  const indexOid = fields[7]!;

  assertOid(headOid);
  assertOid(indexOid);

  const scoreField = fields[8]!;
  const scoreMatch = /^[RC](\d+)$/.exec(scoreField);

  if (!scoreMatch) malformed();

  return {
    kind: "rename",
    path: fields.slice(9).join(" "),
    originalPath,
    index,
    worktree,
    submodule: fields[2]!,
    headOid,
    indexOid,
    score: Number(scoreMatch[1]),
  };
}

function parseUnmerged(record: string): RepositoryChange {
  const fields = record.split(" ");

  if (fields.length < 11) malformed();

  const [index, worktree] = parseXy(fields[1]);

  return {
    kind: "unmerged",
    path: fields.slice(10).join(" "),
    index,
    worktree,
    submodule: fields[2]!,
  };
}

function parseXy(value: string | undefined): [ChangeCode, ChangeCode] {
  if (
    value?.length !== 2 ||
    !CHANGE_CODES.has(value[0] as ChangeCode) ||
    !CHANGE_CODES.has(value[1] as ChangeCode)
  )
    malformed();

  return [value[0] as ChangeCode, value[1] as ChangeCode];
}

function assertOid(value: string): void {
  if (!isFullObjectId(value)) malformed();
}

function malformed(): never {
  throw new AppError(ERROR_CODE.INVALID_STATUS_OUTPUT);
}

// In git ls-files -v output, H is an ordinary cached entry.
export function hasSpecialIndexFlags(flags: string): boolean {
  return flags.split("\0").some((entry) => entry.length > 0 && !entry.startsWith("H "));
}
