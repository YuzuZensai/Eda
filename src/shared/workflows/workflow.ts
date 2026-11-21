export type WorkflowKind =
  "merge" | "squash" | "stash" | "rebase" | "cherry-pick" | "revert" | "am" | "unknown";

export type MergeMode = "ff" | "no-ff" | "ff-only" | "squash";

export interface MergePrediction {
  state: "clean" | "conflicted" | "unavailable";
  paths: string[];
  totalPaths: number;
  reason?: string;
}

export interface MergeStartPreview {
  token: string;
  source: string;
  head: string;
  branch: string;
  mode: MergeMode;
  fastForward: boolean;
  upToDate: boolean;
  prediction: MergePrediction;
}

export interface MergeStartResult {
  state: "completed" | "conflicted" | "ready-to-commit";
  head: string;
}

export interface MergeAbortPreview {
  token: string;
  paths: string[];
  bytes: number;
  originalHead: string;
}

export interface MergeContinuation {
  squash?: boolean;
  id: string;
  message: string;
  author: string;
  email: string;
  signing: boolean;
  head: string;
  incoming: string[];
  state: "prepared" | "running" | "paused" | "completed";
  updatedAt: string;
  result?: string;
}

export interface WorkflowState {
  instance?: string;
  originalBranch?: string | null;
  rebaseOnto?: string | null;
  rebaseEdit?: boolean;
  ownerProfileId?: string;
  kind: WorkflowKind;
  token: string;
  head: string | null;
  originalHead: string | null;
  incoming: string[];
  step: number | null;
  total: number | null;
  conflicts: string[];
  currentLabel: string;
  incomingLabel: string;
}

export interface ConflictVersion {
  oid: string;
  mode: string;
  bytes: number;
  text: string | null;
}

export interface ConflictPreview {
  token: string;
  path: string;
  markerSize: number;
  hasMarkers: boolean;
  workflow: WorkflowState | null;
  base: ConflictVersion | null;
  current: ConflictVersion | null;
  incoming: ConflictVersion | null;
  output: string | null;
  outputKind: "file" | "symlink" | "directory" | "missing";
  newline: "lf" | "crlf";
}

export interface ResolveConflictRequest {
  repositoryId: string;
  token: string;
  choice: "text" | "current" | "incoming" | "delete" | "worktree";
  text?: string;
  stage: boolean;
}
