import type { WorkflowState } from "../workflows/workflow";

export type ObjectId = string;
export type DiffMode = "unified" | "split";

export const CHANGE_AREAS = ["conflicted", "staged", "unstaged", "untracked"] as const;
export type ChangeArea = (typeof CHANGE_AREAS)[number];
export type DiffArea = Extract<ChangeArea, "staged" | "unstaged">;

export const HISTORY_PAGE_SIZE = 100;
export const MAX_HISTORY_PAGE_SIZE = 200;

export type ChangeCode = "." | "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?" | "!";

export interface RepositoryBranchStatus {
  oid?: ObjectId;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  unborn: boolean;
}

export interface RepositoryChange {
  kind: "ordinary" | "rename" | "unmerged" | "untracked" | "ignored";
  path: string;
  originalPath?: string;
  index: ChangeCode;
  worktree: ChangeCode;
  submodule: string;
  headOid?: ObjectId;
  indexOid?: ObjectId;
  score?: number;
}

export interface RepositoryStatus {
  workflow?: WorkflowState | null;
  capabilities?: RepositoryCapabilities;
  branch: RepositoryBranchStatus;
  changes: RepositoryChange[];
}

export interface RepositoryCapabilities {
  shallow?: boolean;
  sparse?: boolean;
  partial?: boolean;
  objectFormat?: string;
  write: boolean;
  reason?: string;
}

export type CommitDecorationType = "head" | "local-branch" | "remote-branch" | "tag" | "ref";

export interface CommitDecoration {
  type: CommitDecorationType;
  name: string;
  target?: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
  timestamp: string;
}

export interface HistoryCommit {
  stashLabels?: string[];
  oid: ObjectId;
  parents: ObjectId[];
  author: CommitAuthor;
  committerTimestamp: string;
  subject: string;
  body: string;
  decorations: CommitDecoration[];
}

export interface HistoryPage {
  commits: HistoryCommit[];
  nextOffset: number | null;
}

export const HISTORY_SEARCH_FIELDS = [
  "message",
  "author",
  "path",
  "since",
  "until",
  "ref",
  "sha",
] as const;
export type HistorySearchField = (typeof HISTORY_SEARCH_FIELDS)[number];
export function isHistorySearchField(field: unknown): field is HistorySearchField {
  return HISTORY_SEARCH_FIELDS.some((item) => item === field);
}

export interface HistoryPageRequest {
  search?: { field: HistorySearchField; text: string };
  showStashes?: boolean;
  showInternalRefs?: boolean;
  repositoryId: string;
  offset?: number;
  limit?: number;
  refs?: string[];
  hiddenRefs?: string[];
}

export interface CommitInspection {
  commit: HistoryCommit;
  containingRefs: string[];
  shallow: boolean;
  signed: boolean;
  signature: CommitSignatureVerification;
}

export type CommitSignatureFormat = "openpgp" | "ssh" | "x509" | "unknown";

export type SignerTrust = "unknown" | "local" | "trusted" | "distrusted";
export interface SignerDecision {
  fingerprint: string;
  identity: string;
  scope: "repository" | "profile";
  decision: "trusted" | "distrusted";
}
export type PublicKeyRequest =
  | { source: "automatic" }
  | { source: "github"; account: string }
  | { source: "keyserver"; server: string }
  | { source: "manual"; armoredKey: string };

export interface CommitSignatureVerification {
  validity?: "valid" | "invalid" | "unknown";
  signerTrust?: SignerTrust;
  trustedIdentity?: string;
  trustScope?: "repository" | "profile";
  keySource?: string;
  keyFetchedAt?: string;
  keyDiscovery?: "unavailable";
  identityMismatch?: boolean;
  authorEmail?: string;
  committerEmail?: string;
  status: "verified" | "invalid" | "unverified" | "unsigned";
  format: CommitSignatureFormat | null;
  reasonCode:
    | "bad-signature"
    | "missing-key"
    | "missing-trust"
    | "untrusted-key"
    | "expired-signature"
    | "expired-key"
    | "revoked-key"
    | "verification-error"
    | "unsupported-format"
    | null;
  signer?: string;
  keyId?: string;
  fingerprint?: string;
  primaryFingerprint?: string;
  trustLevel?: "undefined" | "never" | "marginal" | "fully" | "ultimate";
  diagnostics: string;
}

export const UNSIGNED_COMMIT_SIGNATURE: Readonly<CommitSignatureVerification> = Object.freeze({
  status: "unsigned",
  format: null,
  reasonCode: null,
  diagnostics: "",
});

export const UNVERIFIED_COMMIT_SIGNATURE: Readonly<CommitSignatureVerification> = Object.freeze({
  status: "unverified",
  format: null,
  reasonCode: "verification-error",
  diagnostics: "",
});

export type DiffLineType = "context" | "addition" | "deletion" | "no-newline";

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff {
  stats?: {
    lines: number;
    additions: number;
    deletions: number;
    characters: number;
    longestLine: number;
  };
  truncated?: boolean;
  oldPath?: string;
  newPath?: string;
  oldMode?: string;
  newMode?: string;
  status: "added" | "deleted" | "modified" | "renamed" | "copied" | "type-changed";
  binary: boolean;
  hunks: DiffHunk[];
}

export interface UnifiedDiff {
  files: FileDiff[];
  omittedFiles?: number;
}

export interface RepositoryPathsRequest {
  repositoryId: string;
  paths?: string[];
}

export interface DiffDisplayOptions {
  context?: "expanded" | "full";
  ignoreWhitespace?: boolean;
}

export interface WorkingDiffRequest extends RepositoryPathsRequest, DiffDisplayOptions {
  area: DiffArea;
}

export interface CommitDiffRequest extends RepositoryPathsRequest, DiffDisplayOptions {
  oid: ObjectId;
}

export type RevisionComparisonMode = "direct" | "merge-base";

export interface RevisionComparisonRequest {
  repositoryId: string;
  left: string;
  right: string;
  mode: RevisionComparisonMode;
}

export type ComparisonFile = Pick<FileDiff, "oldPath" | "newPath" | "status">;

export interface RevisionComparison {
  leftOid: ObjectId;
  rightOid: ObjectId;
  /** The left commit for a direct comparison, or the common ancestor for a merge-base comparison. */
  baseOid: ObjectId;
  files: ComparisonFile[];
  omittedFiles: number;
}

export interface ComparisonDiffRequest extends DiffDisplayOptions {
  repositoryId: string;
  baseOid: ObjectId;
  rightOid: ObjectId;
  path: string;
  oldPath?: string;
}

export type PatchExportRequest = { repositoryId: string } & (
  { area: DiffArea; path: string } | { oid: ObjectId; path?: string; oldPath?: string }
);

export interface SubmoduleSummary {
  path: string;
  state: "missing" | "uninitialized" | "uninspected" | "initialized" | "outOfSync" | "conflicted";
  directory?: string;
  dirty?: boolean;
}

export const submoduleUpdateModes = ["checkout", "merge", "rebase"] as const;
export type SubmoduleUpdateMode = (typeof submoduleUpdateModes)[number];

export interface SubmoduleListing {
  automatic?: boolean;
  defaultMode?: SubmoduleUpdateMode;
  entries: SubmoduleSummary[];
  parent?: string;
}

export interface WorktreeSummary {
  current?: boolean;
  changedPaths?: number;
  path: string;
  main: boolean;
  bare: boolean;
  available: boolean;
  branch?: string;
  oid?: ObjectId;
  locked?: string;
  prunable?: string;
}

export interface RevisionPathRequest {
  repositoryId: string;
  oid: ObjectId;
  path?: string;
}

export type RevisionPath =
  | { kind: "tree"; entries: { name: string; type: "tree" | "blob" | "commit"; oid: string }[] }
  | { kind: "text"; text: string; lfs?: { oid: string; bytes: number } }
  | { kind: "binary" | "large"; bytes: number };

export interface BlameRequest extends RevisionPathRequest {
  path: string;
  start: number;
}
export interface BlameLine {
  oid: string;
  author: string;
  text: string;
  previous?: { oid: string; path: string };
}
