import type {
  CommitSignatureVerification,
  ObjectId,
  RepositoryPathsRequest,
  SubmoduleUpdateMode,
} from "./repository-read";

export type SubmoduleAction =
  | { kind: "add"; path: string; url: string }
  | {
      kind: "init" | "sync" | "update";
      path: string;
      recursive: boolean;
      mode: SubmoduleUpdateMode;
    }
  | { kind: "remove"; path: string }
  | { kind: "automatic"; enabled: boolean };

export type WorktreeAction =
  | { kind: "create"; path: string; branch: string; base?: string }
  | { kind: "lock" | "unlock"; path: string }
  | { kind: "remove" | "cleanup"; path: string; oid: string; branch?: string }
  | { kind: "prune" };

export interface BranchSummary {
  name: string;
  oid: ObjectId;
  isHead: boolean;
  remote: boolean;
  upstream?: string;
  worktreePath?: string;
}

export interface TagSummary {
  name: string;
  oid: ObjectId;
  createdAt?: string;
  annotated?: boolean;
  message?: string;
  tagger?: string;
}

export type StageRequest = RepositoryPathsRequest;

export interface CommitRequest {
  repositoryId: string;
  message: string;
  amend?: boolean;
  signOff?: boolean;
  skipCommitHooks?: boolean;
  stagePaths?: string[];
}

export interface CommitResult {
  oid: ObjectId;
  publishedCommits?: number;
}

export interface BranchRequest {
  repositoryId: string;
  name: string;
}

export interface CreateBranchRequest extends BranchRequest {
  checkout?: boolean;
  startPoint?: ObjectId;
}

export interface DeleteBranchRequest extends BranchRequest {
  force?: boolean;
}

export interface RenameBranchRequest {
  repositoryId: string;
  from: string;
  to: string;
}

export interface CreateTagRequest {
  sign?: boolean;
  repositoryId: string;
  name: string;
  message?: string;
  target?: ObjectId;
}

export interface TagRequest {
  repositoryId: string;
  name: string;
}

export interface TagVerification extends CommitSignatureVerification {
  oid: string;
}

export interface CommitPreview {
  author: { name?: string; email?: string };
  matchesProfile: boolean;
  signing: string;
  signingEnabled: boolean;
  additions: number;
  deletions: number;
  binaryFiles: number;
  sharedRefs: string[];
}
