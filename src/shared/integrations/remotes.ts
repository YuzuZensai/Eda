import type { BranchSummary } from "../repository/repository-write";

export interface RemoteSummary {
  name: string;
  fetchUrls: string[];
  pushUrls: string[];
}

export interface RemoteState {
  remotes: RemoteSummary[];
  branches: (BranchSummary & { upstreamState: string })[];
}

export type RemoteChange =
  | { kind: "add"; name: string; url: string }
  | { kind: "url"; name: string; url: string; push: boolean }
  | { kind: "rename"; name: string; to: string }
  | { kind: "remove"; name: string };

export interface TransportCredentials {
  username: string;
  password: string;
}

export interface FetchRequest {
  repositoryId: string;
  remote: string | null;
  prune: boolean;
  tags: boolean;
  tag?: string;
  credentials?: TransportCredentials;
}

export const PUSH_MODES = ["normal", "lease", "force", "delete"] as const;
export type PushMode = (typeof PUSH_MODES)[number];
export const REMOTE_REF_KINDS = ["branch", "tag"] as const;
export type RemoteRefKind = (typeof REMOTE_REF_KINDS)[number];

export interface RemoteTagsRequest {
  repositoryId: string;
  remote: string;
  credentials?: TransportCredentials;
}

export interface RemoteTagSummary {
  name: string;
  oid: string;
}

export interface PushRequest {
  repositoryId: string;
  remote: string;
  branch: string;
  destination: string;
  setUpstream: boolean;
  mode: PushMode;
  refKind?: RemoteRefKind;
  credentials?: TransportCredentials;
}

export interface PushPreview {
  token: string;
  url: string;
  source: string;
  destination: string;
  localOid: string | null;
  remoteOid: string | null;
  mode: PushMode;
}

export interface CloneRequest {
  profileId: string;
  url: string;
  parent: string;
  name: string;
  credentials?: TransportCredentials;
}

export function remoteForTrackingRef(
  remotes: readonly RemoteSummary[],
  ref: string | null | undefined,
): RemoteSummary | undefined {
  if (!ref) return undefined;
  return remotes.reduce<RemoteSummary | undefined>(
    (match, remote) =>
      ref.startsWith(`${remote.name}/`) && (!match || remote.name.length > match.name.length)
        ? remote
        : match,
    undefined,
  );
}

export function preferredRemote(state: RemoteState): RemoteSummary | undefined {
  const head = state.branches.find((branch) => branch.isHead && !branch.remote);
  return (
    remoteForTrackingRef(state.remotes, head?.upstream) ??
    state.remotes.find((remote) => remote.name === "origin") ??
    state.remotes[0]
  );
}
