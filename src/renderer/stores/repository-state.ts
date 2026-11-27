import { err, type GitErrorData } from "@shared/errors";
import { errorText } from "@shared/error-codes";
import { t, type MessageKey } from "@shared/i18n";
import type { SavedSelection } from "@shared/identity/profile-session";
import {
  type ChangeArea,
  type RepositoryChange,
  type RepositoryStatus,
  type UnifiedDiff,
} from "@shared/repository/repository-read";
import type { BranchSummary } from "@shared/repository/repository-write";
import { type HistoryWindow } from "./history-pagination";

export type RepositorySelection = SavedSelection;

export function repositoryRequestFailure(operation: MessageKey) {
  return err({ kind: "unknown", operation: t(operation), message: errorText("errors.unexpected") });
}

export function sameSelection(
  current: RepositorySelection | undefined,
  next: Exclude<RepositorySelection, null>,
): boolean {
  return next.kind === "commit"
    ? current?.kind === "commit" && current.oid === next.oid
    : current?.kind === "change" && current.area === next.area && current.path === next.path;
}

export interface RepositoryReadState extends HistoryWindow {
  commandDialog: {
    kind:
      | "repository.references"
      | "repository.worktrees"
      | "repository.graph"
      | "repository.recovery"
      | "repository.historyRecovery"
      | "repository.undoRedo"
      | "repository.createBranch"
      | "repository.createTag";
    oid: string | undefined;
  } | null;

  repositoryId: string | null;
  identityId: string | null;
  phase: "idle" | "loading" | "ready" | "missing" | "error";
  status: RepositoryStatus | null;
  branches: BranchSummary[];
  hoveredRefOid: string | null;
  watchWarning: string | null;
  selection: RepositorySelection;
  contentView:
    | "history"
    | "diff"
    | { kind: "tree"; oid: string; path?: string }
    | { kind: "comparison"; left: string; right: string };
  commitFilePath: string | null;
  commitFileDiff: UnifiedDiff | null;
  commitFileLoading: boolean;
  commitFileError: GitErrorData | null;
  selectCommitFile: (path: string) => Promise<void>;
  showHistory: () => void;
  compareRevisions: (left?: string, right?: string) => void;
  showWorkingTree: () => void;
  navigation: Exclude<RepositorySelection, null>[];
  navigationIndex: number;
  navigate: (direction: -1 | 1) => Promise<void>;
  diff: UnifiedDiff | null;
  diffLoading: boolean;
  error: GitErrorData | null;
  truncatedChanges: boolean;
  generation: number;

  open: (repositoryId: string, identityId: string, available: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  syncFromDisk: () => Promise<void>;
  loadMore: () => Promise<void>;
  loadPrevious: () => Promise<void>;
  selectChange: (
    change: RepositoryChange,
    area: ChangeArea,
    openConflict?: boolean,
  ) => Promise<void>;
  retryDiff: () => Promise<void>;
  selectCommit: (oid: string) => Promise<void>;
  jumpToCommit: (oid: string) => Promise<void>;
  clear: () => void;

  stage: (paths?: string[]) => Promise<void>;
  unstage: (paths?: string[]) => Promise<void>;
  stash: (paths?: string[]) => Promise<void>;
  popStash: () => Promise<void>;
  stashNotice: string | null;
  applyPartial: (token: string) => Promise<boolean>;

  commit: (
    message: string,
    options?: {
      amend?: boolean;
      skipCommitHooks?: boolean;
      signOff?: boolean;
      stagePaths?: string[];
    },
  ) => Promise<boolean>;

  writing: boolean;
  writeError: GitErrorData | null;
  commitNotice: string | null;
}
