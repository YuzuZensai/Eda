import type { CommitInspection, UnifiedDiff } from "../repository/repository-read";
import type { ResetMode } from "./reset";

export type HistoryDirection = "undo" | "redo";
export type BranchCheckoutPhase = "original" | HistoryDirection;

export const RECOVERY_PAGE_SIZE = 200;

export type HistoryReversalKind =
  "reset" | "commit" | "amend" | "branch" | "checkout" | "rebase" | "cherry-pick" | "revert";

export interface HistoryReversal {
  kind: HistoryReversalKind;
  mode?: ResetMode;
  fromHead: string;
  toHead: string;
  id: string;
  label: string;
  direction: HistoryDirection;
  available: boolean;
  publishedCommits: number;
  reason?: string;
  reconciliation?: "applied" | "undone";
  dismissUnstarted?: boolean;
  resumeBranchCheckout?: BranchCheckoutPhase;
  resumeIndex?: boolean;
  resumeReset?: boolean;
  resumeConfiguration?: boolean;
  branch?: string;
}

export type RecoverySource = "reflog" | "saved" | "unreachable" | "rewrites" | "dangling";

export interface RecoveryEntry {
  oid: string;
  label: string;
  description: string;
}

export interface RecoveryPage {
  cleanup?: { token: string; count: number };
  entries: RecoveryEntry[];
  nextOffset: number | null;
}

export interface RecoveryInspection {
  token: string;
  inspection: CommitInspection;
  diff: UnifiedDiff;
  diffNotice?: string;
}
