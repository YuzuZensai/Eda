import type { ProviderRepositoryPage } from "./integrations/provider-repositories";
import type {
  GitLabSelfHostedStatus,
  GitLabSelfHostedAccountProfile,
  GitLabTokenForm,
} from "./integrations/gitlab-self-hosted";
import type {
  GitLabStatus,
  GitLabSignIn,
  GitLabSignInResult,
  GitLabAccountProfile,
} from "./integrations/gitlab";
import type { DesktopPlatform, GraphicsStatus, InstallationInfo } from "./application";
import type { GitEngineInfo } from "./integrations/git-engine";
import type { AvatarImage } from "./identity/avatar";
import type { BuildInfo } from "./version";
import type { UpdateState } from "./updates";
import type {
  GitHubStatus,
  GitHubSignIn,
  GitHubSignInResult,
  GitHubAccountProfile,
} from "./integrations/github";
import type { DetectedMergeTool } from "./integrations/merge-tool";
import type { DetectedEditor } from "./integrations/editor";
import type { BackgroundFetchState } from "./integrations/background-fetch";
import type { ReplayAction, ReplayKind, ReplayReview, ReplayResult } from "./workflows/replay";
import type { ResetMode, ResetReview, ResetResult } from "./workflows/reset";
import type {
  HistoryReversal,
  HistoryDirection,
  BranchCheckoutPhase,
  RecoveryInspection,
  RecoveryPage,
  RecoverySource,
} from "./workflows/history-recovery";
import type { PullPreview, PullRequest, PullStrategy } from "./workflows/pull";
import type { RebaseAction, RebaseReview, RebaseResult, RebasePlanEntry } from "./workflows/rebase";
import type { Result } from "./errors";
import type { GpgSigningKey } from "./identity/signing";
import type {
  StashList,
  StashInspection,
  StashContents,
  StashCreateOptions,
  StashArea,
  StashFilePreview,
  StashBranchPreview,
} from "./workflows/stashes";
import type {
  CloneRequest,
  FetchRequest,
  PushPreview,
  PushRequest,
  RemoteChange,
  RemoteState,
  RemoteTagsRequest,
  RemoteTagSummary,
  TransportCredentials,
} from "./integrations/remotes";
import type { ReferenceLinkKind } from "./repository/reference-link";
import type { ImagePreview, ImagePreviewRequest } from "./repository/image-preview";
import type { IgnoreInspection, IgnoreKind } from "./repository/ignore";
import type { DiscardPreview, RecoverySummary } from "./workflows/recovery";

import type { RepositoryNavigation } from "./repository/navigation";
import type {
  Identity,
  IdentityCreateOptions,
  IdentityDraft,
  IdentitySwitchReport,
  SigningConfiguration,
} from "./identity/identity";
import type {
  RepositorySummary,
  InitRepositoryOptions,
  RepositoryTrustRequest,
} from "./repository/repository";
import type {
  DuplicateProfileOptions,
  ProfileDeletePreview,
  ProfileGitInspection,
  CommitConfigGroup,
  SessionContext,
  SessionChange,
  SessionSnapshot,
} from "./identity/profile-session";
import type {
  ResolvedSetting,
  SettingChanged,
  SettingKey,
  SettingScope,
  SettingValues,
  SettingsContext,
} from "./preferences/settings";
import type {
  CommitDiffRequest,
  CommitInspection,
  CommitSignatureVerification,
  HistoryPage,
  HistoryPageRequest,
  RepositoryStatus,
  UnifiedDiff,
  WorkingDiffRequest,
} from "./repository/repository-read";
import type {
  BranchRequest,
  BranchSummary,
  CommitRequest,
  CommitPreview,
  CommitResult,
  CreateBranchRequest,
  CreateTagRequest,
  DeleteBranchRequest,
  RenameBranchRequest,
  StageRequest,
  TagRequest,
  TagSummary,
  TagVerification,
} from "./repository/repository-write";
import type {
  AgentStatus,
  ConnectionTestResult,
  GenerateKeyRequest,
  SshKey,
  UnlockKeyRequest,
  SecretMetadata,
  UnlockCredentialRequest,
  SshHostTrustRequest,
} from "./identity/ssh";

import type { OperationRecord } from "./operations";
import type { PartialStageRequest, PartialStagePreview } from "./repository/partial-stage";
import type {
  ConflictPreview,
  ResolveConflictRequest,
  MergeContinuation,
  MergeAbortPreview,
  MergeStartPreview,
  MergeStartResult,
  MergeMode,
} from "./workflows/workflow";

export interface EdaApi {
  avatars: {
    get(email: string): Promise<Result<AvatarImage>>;
    getCommit(repositoryId: string, email: string): Promise<Result<AvatarImage>>;
  };

  backgroundFetch: {
    inspect(id: string): Promise<Result<BackgroundFetchState>>;
    configure(id: string, minutes: number | null): Promise<Result<void>>;
    retry(id: string, remote: string): Promise<Result<void>>;
  };

  pull: {
    preference(id: string): Promise<Result<ResolvedSetting<"pullStrategy">>>;
    setPreference(id: string, strategy: PullStrategy | null): Promise<Result<void>>;
    prepare(request: PullRequest): Promise<Result<PullPreview>>;
    execute(id: string, token: string): Promise<Result<string>>;
  };

  rebase: {
    prepare(
      repositoryId: string,
      action: RebaseAction,
      onto?: string,
      interactive?: boolean,
    ): Promise<Result<RebaseReview>>;
    execute(
      repositoryId: string,
      token: string,
      plan?: RebasePlanEntry[],
      message?: string,
    ): Promise<Result<RebaseResult>>;
  };

  replay: {
    prepare(
      repositoryId: string,
      kind: ReplayKind,
      action: ReplayAction,
      commits?: string[],
      mainline?: number,
    ): Promise<Result<ReplayReview>>;
    execute(repositoryId: string, token: string): Promise<Result<ReplayResult>>;
  };

  reset: {
    prepare(repositoryId: string, target: string, mode: ResetMode): Promise<Result<ResetReview>>;
    execute(repositoryId: string, token: string): Promise<Result<ResetResult>>;
  };

  historyRecovery: {
    resumeIndex(
      id: string,
      recordId: string,
      direction: HistoryDirection,
    ): Promise<Result<{ preservedNewerWork: boolean }>>;
    resumeConfiguration(
      id: string,
      recordId: string,
      direction: HistoryDirection,
    ): Promise<Result<void>>;
    resumeReset(
      id: string,
      recordId: string,
      publishedCommits: number,
    ): Promise<Result<{ outcome: "reset" | "recorded" }>>;
    dismissUnstarted(id: string, recordId: string): Promise<Result<void>>;
    resumeBranchCheckout(
      id: string,
      recordId: string,
      phase: BranchCheckoutPhase,
    ): Promise<Result<void>>;
    reconcile(id: string, recordId: string, state: "applied" | "undone"): Promise<Result<void>>;
    reversals(id: string): Promise<Result<HistoryReversal[]>>;
    reverse(
      id: string,
      recordId: string,
      direction: HistoryDirection,
      publishedCommits: number,
    ): Promise<Result<void>>;
    list(id: string, source: RecoverySource, offset?: number): Promise<Result<RecoveryPage>>;
    inspect(id: string, oid: string): Promise<Result<RecoveryInspection>>;
    restore(id: string, token: string, name: string): Promise<Result<string>>;
  };

  stashes: {
    prepareBranch(
      repositoryId: string,
      token: string,
      name: string,
    ): Promise<Result<StashBranchPreview>>;
    createBranch(repositoryId: string, token: string): Promise<Result<{ applied: boolean }>>;
    prepareFile(
      repositoryId: string,
      token: string,
      area: StashArea,
      path: string,
    ): Promise<Result<StashFilePreview>>;
    restoreFile(repositoryId: string, token: string): Promise<Result<void>>;
    list(repositoryId: string): Promise<Result<StashList>>;
    create(
      repositoryId: string,
      message: string,
      contents: StashContents,
      options?: StashCreateOptions,
    ): Promise<Result<void>>;
    inspect(repositoryId: string, selector: string, oid: string): Promise<Result<StashInspection>>;
    apply(
      repositoryId: string,
      token: string,
      pop: boolean,
      restoreIndex: boolean,
    ): Promise<Result<{ applied: boolean; kept: boolean }>>;
    drop(repositoryId: string, token: string): Promise<Result<void>>;
    rename(
      repositoryId: string,
      token: string,
      name: string,
    ): Promise<Result<{ keptOriginal: boolean }>>;
  };

  workflows: {
    finishStash(repositoryId: string, token: string): Promise<Result<void>>;
    prepareStart(
      repositoryId: string,
      source: string,
      mode: MergeMode,
    ): Promise<Result<MergeStartPreview>>;
    startMerge(repositoryId: string, token: string): Promise<Result<MergeStartResult>>;
    prepareAbort(repositoryId: string): Promise<Result<MergeAbortPreview>>;
    abortMerge(repositoryId: string, token: string): Promise<Result<void>>;
    prepareMerge(repositoryId: string): Promise<Result<MergeContinuation>>;
    continueMerge(repositoryId: string, id: string, message: string): Promise<Result<string>>;
  };

  conflicts: {
    external(
      repositoryId: string,
      token: string,
    ): Promise<Result<{ text: string; stale: boolean }>>;
    inspect(repositoryId: string, path: string): Promise<Result<ConflictPreview>>;
    resolve(request: ResolveConflictRequest): Promise<Result<void>>;
  };

  remotes: {
    inspect(id: string): Promise<Result<RemoteState>>;
    listTags(request: RemoteTagsRequest): Promise<Result<RemoteTagSummary[]>>;
    change(id: string, change: RemoteChange): Promise<Result<void>>;
    track(id: string, branch: string, upstream: string | null): Promise<Result<void>>;
    fetch(request: FetchRequest): Promise<Result<string>>;
    preparePush(request: PushRequest): Promise<Result<PushPreview>>;
    push(id: string, token: string, credentials?: TransportCredentials): Promise<Result<string>>;
    clone(request: CloneRequest): Promise<Result<RepositorySummary>>;
  };

  operations: {
    list(): Promise<Result<OperationRecord[]>>;
    cancel(id: string): Promise<Result<void>>;
    retry(id: string): Promise<Result<void>>;
  };

  github: {
    repositories(profileId: string, page?: number): Promise<Result<ProviderRepositoryPage>>;
    maintainerProfile(): Promise<Result<GitHubAccountProfile | null>>;
    status(profileId: string): Promise<Result<GitHubStatus>>;
    profile(profileId: string): Promise<Result<GitHubAccountProfile | null>>;
    openProfile(profileId: string): Promise<Result<void>>;
    begin(profileId: string): Promise<Result<GitHubSignIn>>;
    poll(profileId: string, id: string): Promise<Result<GitHubSignInResult>>;
    cancel(profileId: string, id: string): Promise<Result<void>>;
    openVerification(profileId: string, id: string): Promise<Result<void>>;
    disconnect(profileId: string): Promise<Result<void>>;
  };

  gitlabSelfHosted: {
    profile(
      profileId: string,
      baseUrl: string,
    ): Promise<Result<GitLabSelfHostedAccountProfile | null>>;
    status(profileId: string): Promise<Result<GitLabSelfHostedStatus>>;
    connect(
      profileId: string,
      baseUrl: string,
      token: string,
      ignoreTlsErrors?: boolean,
    ): Promise<Result<GitLabSelfHostedStatus>>;
    cancel(profileId: string): Promise<Result<void>>;
    disconnect(profileId: string, baseUrl: string): Promise<Result<void>>;
    openTokenSettings(
      profileId: string,
      baseUrl: string,
      form?: GitLabTokenForm,
    ): Promise<Result<void>>;
    openProfile(profileId: string, baseUrl: string): Promise<Result<void>>;
    repositories(
      profileId: string,
      baseUrl: string,
      page?: number,
    ): Promise<Result<ProviderRepositoryPage>>;
  };

  gitlab: {
    repositories(profileId: string, page?: number): Promise<Result<ProviderRepositoryPage>>;
    profile(profileId: string): Promise<Result<GitLabAccountProfile | null>>;
    status(profileId: string): Promise<Result<GitLabStatus>>;
    begin(profileId: string): Promise<Result<GitLabSignIn>>;
    poll(profileId: string, id: string): Promise<Result<GitLabSignInResult>>;
    cancel(profileId: string, id: string): Promise<Result<void>>;
    openAuthorization(profileId: string, id: string): Promise<Result<void>>;
    openProfile(profileId: string): Promise<Result<void>>;
    disconnect(profileId: string): Promise<Result<void>>;
  };

  app: {
    readonly version: BuildInfo;
    installation(): Promise<Result<InstallationInfo>>;
    copyText(value: string): Promise<Result<void>>;
    debug(
      action:
        "open-dev-tools" | "ipc-error" | "renderer-crash" | "reset-data" | "import-release-data",
    ): Promise<Result<void>>;
    detectMergeTools(): Promise<Result<DetectedMergeTool[]>>;
    chooseMergeTool(): Promise<Result<string | null>>;
    graphicsStatus(): Promise<Result<GraphicsStatus>>;
    detectEditors(): Promise<Result<DetectedEditor[]>>;
    chooseEditor(): Promise<Result<string | null>>;
    takeNavigation(): Promise<Result<RepositoryNavigation[]>>;
    readonly platform: DesktopPlatform;
    windowControl(
      action: "state" | "minimize" | "toggle-maximize" | "close",
    ): Promise<Result<{ maximized: boolean }>>;
    getGitEngine(): Promise<Result<GitEngineInfo>>;
    getGlobalGitUser(): Promise<Result<{ name?: string; email?: string }>>;
  };

  updates: {
    state(): Promise<Result<UpdateState>>;
    check(): Promise<Result<UpdateState>>;
    download(): Promise<Result<UpdateState>>;
    install(): Promise<Result<UpdateState>>;
  };

  identity: {
    listGpgSigningKeys(): Promise<Result<GpgSigningKey[]>>;
    list(): Promise<Result<Identity[]>>;
    reorder(ids: string[]): Promise<Result<Identity[]>>;
    getActive(): Promise<Result<Identity | null>>;
    create(draft: IdentityDraft, options?: IdentityCreateOptions): Promise<Result<Identity>>;
    update(id: string, draft: Partial<IdentityDraft>): Promise<Result<Identity>>;
    previewDelete(id: string): Promise<Result<ProfileDeletePreview>>;
    delete(id: string, token: string): Promise<Result<void>>;
    duplicate(id: string, options: DuplicateProfileOptions): Promise<Result<Identity>>;
    inspectGit(repositoryId?: string): Promise<Result<ProfileGitInspection>>;
    reapplyGlobal(profileId: string): Promise<Result<void>>;
    setActive(id: string): Promise<Result<IdentitySwitchReport>>;
    assignSshKey(path: string | null, profileId?: string): Promise<Result<Identity>>;
    configureSigning(signing: SigningConfiguration, profileId?: string): Promise<Result<Identity>>;
  };

  repository: {
    reviewTrust(id: string): Promise<Result<void>>;
    pendingTrust(): Promise<Result<RepositoryTrustRequest | null>>;
    respondTrust(id: string, trust: boolean): Promise<Result<void>>;
    referenceUrl(id: string, kind: ReferenceLinkKind, name: string): Promise<Result<string | null>>;
    previewCommit(id: string): Promise<Result<CommitPreview>>;
    inspectCommit(
      id: string,
      oid: string,
      refreshSignature?: boolean,
    ): Promise<Result<CommitInspection>>;
    commitSignature(id: string, oid: string): Promise<Result<CommitSignatureVerification>>;
    ignoredFiles(id: string): Promise<Result<{ paths: string[]; truncated: boolean }>>;
    openEditor(id: string): Promise<Result<void>>;
    openDropped(file: File): Promise<Result<RepositorySummary>>;
    commitTemplate(id: string): Promise<Result<string | null>>;
    previewDiscard(id: string, paths: string[]): Promise<Result<DiscardPreview>>;
    previewDiscardPartial(request: PartialStageRequest): Promise<Result<DiscardPreview>>;
    applyDiscard(id: string, token: string): Promise<Result<void>>;
    listRecovery(id: string): Promise<Result<RecoverySummary[]>>;
    forgetRecovery(id: string, snapshot: string): Promise<Result<void>>;
    restoreContent(id: string, snapshot: string): Promise<Result<void>>;
    exportRecoveryFile(
      id: string,
      snapshot: string,
      path: string,
      stage?: number,
    ): Promise<Result<boolean>>;
    inspectIgnore(id: string, path: string, kind: IgnoreKind): Promise<Result<IgnoreInspection>>;
    addIgnore(id: string, path: string, kind: IgnoreKind): Promise<Result<void>>;
    stopTracking(id: string, path: string): Promise<Result<void>>;
    updateMetadata(
      id: string,
      metadata: { name: string; favourite: boolean },
    ): Promise<Result<void>>;
    reveal(id: string): Promise<Result<void>>;
    list(): Promise<Result<RepositorySummary[]>>;
    open(path: string): Promise<Result<RepositorySummary>>;
    relocate(id: string, path: string): Promise<Result<RepositorySummary>>;
    init(path: string, options?: InitRepositoryOptions): Promise<Result<RepositorySummary>>;
    remove(id: string): Promise<Result<void>>;
    status(id: string): Promise<Result<RepositoryStatus>>;
    history(request: HistoryPageRequest): Promise<Result<HistoryPage>>;
    workingDiff(request: WorkingDiffRequest): Promise<Result<UnifiedDiff>>;
    commitDiff(request: CommitDiffRequest): Promise<Result<UnifiedDiff>>;
    imagePreview(request: ImagePreviewRequest): Promise<Result<ImagePreview>>;
    chooseFolder(): Promise<Result<string | null>>;
    watch(id: string | null): Promise<Result<void>>;
    applyProfile(id: string): Promise<Result<void>>;
    clearLocalCommitConfig(id: string, group: CommitConfigGroup): Promise<Result<void>>;
    assignProfile(
      repositoryId: string,
      targetProfileId: string,
      move: boolean,
    ): Promise<Result<string>>;
    suggestProfile(path: string): Promise<Result<{ id: string; name: string } | null>>;

    stage(request: StageRequest): Promise<Result<void>>;
    previewPartial(request: PartialStageRequest): Promise<Result<PartialStagePreview>>;
    applyPartial(repositoryId: string, token: string): Promise<Result<void>>;
    unstage(request: StageRequest): Promise<Result<void>>;
    commit(request: CommitRequest): Promise<Result<CommitResult>>;

    listBranches(id: string): Promise<Result<BranchSummary[]>>;
    createBranch(request: CreateBranchRequest): Promise<Result<void>>;
    checkoutBranch(request: BranchRequest): Promise<Result<void>>;
    deleteBranch(request: DeleteBranchRequest): Promise<Result<void>>;
    renameBranch(request: RenameBranchRequest): Promise<Result<void>>;

    verifyTag(request: TagRequest): Promise<Result<TagVerification>>;
    listTags(id: string): Promise<Result<TagSummary[]>>;
    createTag(request: CreateTagRequest): Promise<Result<void>>;
    deleteTag(request: TagRequest): Promise<Result<void>>;
    checkoutTag(request: TagRequest): Promise<Result<void>>;
  };

  ssh: {
    listKeys(): Promise<Result<SshKey[]>>;
    importKey(privateKeyPath: string): Promise<Result<SshKey>>;
    generateKey(request: GenerateKeyRequest): Promise<Result<SshKey>>;
    getAgentStatus(): Promise<Result<AgentStatus>>;
    unlockKey(request: UnlockKeyRequest, passphrase: string): Promise<Result<AgentStatus>>;
    lockKey(keyPath: string): Promise<Result<AgentStatus>>;
    testConnection(host: string, keyPath: string): Promise<Result<ConnectionTestResult>>;
    pendingHostTrust(): Promise<Result<SshHostTrustRequest | null>>;
    respondHostTrust(id: string, trust: boolean): Promise<Result<void>>;
    choosePrivateKey(): Promise<Result<string | null>>;
    choosePublicKey(): Promise<Result<string | null>>;
    chooseKeyDestination(): Promise<Result<string | null>>;
  };

  credentials: {
    getSecretMetadata(profileId?: string): Promise<Result<SecretMetadata>>;
    unlockActiveKey(
      request: UnlockCredentialRequest,
      passphrase?: string,
      profileId?: string,
    ): Promise<Result<AgentStatus>>;
    forgetActivePassphrase(profileId?: string): Promise<Result<void>>;
  };

  settings: {
    resolve<K extends SettingKey>(
      key: K,
      context: SettingsContext,
    ): Promise<Result<ResolvedSetting<K>>>;
    set<K extends SettingKey>(
      key: K,
      scope: SettingScope,
      value: SettingValues[K],
    ): Promise<Result<void>>;
    reset(key: SettingKey, scope: SettingScope): Promise<Result<void>>;
    chooseBackgroundImage(): Promise<Result<string | null>>;
    previewGlobalAppearance(enabled: boolean): Promise<Result<void>>;
  };

  sessions: {
    open(): Promise<Result<SessionSnapshot | null>>;
    change(context: SessionContext, change: SessionChange): Promise<Result<void>>;
    reset(context: SessionContext): Promise<Result<SessionSnapshot | null>>;
    readyToClose(nonce: string): Promise<Result<void>>;
  };

  events: {
    onUpdateChanged(handler: (state: UpdateState) => void): () => void;
    onRepositoryTrustChanged(handler: (request: RepositoryTrustRequest | null) => void): () => void;
    onSshHostTrustChanged(handler: (request: SshHostTrustRequest | null) => void): () => void;
    onNavigation(handler: () => void): () => void;
    onOperationsChanged(handler: () => void): () => void;
    onIdentityChanged(handler: (identity: Identity | null) => void): () => void;
    onRepositoriesChanged(handler: () => void): () => void;
    onRepositoryChanged(handler: (repositoryId: string, warning?: string) => void): () => void;
    onSettingChanged(handler: (change: SettingChanged) => void): () => void;
    onFlushRequested(handler: (nonce: string) => void): () => void;
  };
}

export const IPC_CHANNELS = {
  updatesState: "updates:state",
  updatesCheck: "updates:check",
  updatesDownload: "updates:download",
  updatesInstall: "updates:install",
  gitlabSelfHostedStatus: "gitlab-self-hosted:status",
  gitlabSelfHostedProfile: "gitlab-self-hosted:profile",
  gitlabSelfHostedConnect: "gitlab-self-hosted:connect",
  gitlabSelfHostedCancel: "gitlab-self-hosted:cancel",
  gitlabSelfHostedDisconnect: "gitlab-self-hosted:disconnect",
  gitlabSelfHostedOpenTokenSettings: "gitlab-self-hosted:open-token-settings",
  gitlabSelfHostedOpenProfile: "gitlab-self-hosted:open-profile",
  gitlabSelfHostedRepositories: "gitlab-self-hosted:repositories",
  gitlabProfile: "gitlab:profile",
  gitlabRepositories: "gitlab:repositories",
  gitlabStatus: "gitlab:status",
  gitlabBegin: "gitlab:begin",
  gitlabPoll: "gitlab:poll",
  gitlabCancel: "gitlab:cancel",
  gitlabOpenAuthorization: "gitlab:open-authorization",
  gitlabOpenProfile: "gitlab:open-profile",
  gitlabDisconnect: "gitlab:disconnect",
  githubRepositories: "github:repositories",
  githubStatus: "github:status",
  githubProfile: "github:profile",
  githubMaintainerProfile: "github:maintainer-profile",
  githubOpenProfile: "github:open-profile",
  githubBegin: "github:begin",
  githubPoll: "github:poll",
  githubCancel: "github:cancel",
  githubOpenVerification: "github:open-verification",
  githubDisconnect: "github:disconnect",
  avatarGet: "avatar:get",
  avatarCommitGet: "avatar:commit-get",
  identityListGpgSigningKeys: "identity:listGpgSigningKeys",
  backgroundFetchInspect: "background-fetch:inspect",
  backgroundFetchConfigure: "background-fetch:configure",
  backgroundFetchRetry: "background-fetch:retry",
  pullPreference: "pull:preference",
  pullSetPreference: "pull:set-preference",
  pullPrepare: "pull:prepare",
  pullExecute: "pull:execute",
  rebasePrepare: "rebase:prepare",
  rebaseExecute: "rebase:execute",
  replayPrepare: "replay:prepare",
  replayExecute: "replay:execute",
  resetPrepare: "reset:prepare",
  historyReversals: "history-recovery:reversals",
  historyReconcile: "history-recovery:reconcile",
  historyDismissUnstarted: "history-recovery:dismiss-unstarted",
  historyResumeBranchCheckout: "history-recovery:resume-branch-checkout",
  historyResumeIndex: "history-recovery:resume-index",
  historyResumeReset: "history-recovery:resume-reset",
  historyResumeConfiguration: "history-recovery:resume-configuration",
  historyReverse: "history-recovery:reverse",
  historyRecoveryList: "history-recovery:list",
  historyRecoveryInspect: "history-recovery:inspect",
  historyRecoveryRestore: "history-recovery:restore",
  resetExecute: "reset:execute",
  stashesList: "stashes:list",
  stashesCreate: "stashes:create",
  stashesInspect: "stashes:inspect",
  stashesApply: "stashes:apply",
  workflowFinishStash: "workflow:finish-stash",
  stashesDrop: "stashes:drop",
  stashesRename: "stashes:rename",
  stashesPrepareFile: "stashes:prepare-file",
  stashesRestoreFile: "stashes:restore-file",
  stashesPrepareBranch: "stashes:prepare-branch",
  stashesCreateBranch: "stashes:create-branch",
  workflowPrepareStart: "workflow:prepare-start",
  workflowStartMerge: "workflow:start-merge",
  workflowPrepareAbort: "workflow:prepare-abort",
  workflowAbortMerge: "workflow:abort-merge",
  workflowPrepareMerge: "workflow:prepare-merge",
  workflowContinueMerge: "workflow:continue-merge",
  conflictInspect: "conflict:inspect",
  conflictExternal: "conflict:external",
  conflictResolve: "conflict:resolve",
  remotesInspect: "remotes:inspect",
  remotesListTags: "remotes:list-tags",
  remotesChange: "remotes:change",
  remotesTrack: "remotes:track",
  remotesFetch: "remotes:fetch",
  remotesPreparePush: "remotes:prepare-push",
  remotesPush: "remotes:push",
  remotesClone: "remotes:clone",
  repositoryIgnoredFiles: "repository:ignored-files",
  appDetectMergeTools: "app:detect-merge-tools",
  appChooseMergeTool: "app:choose-merge-tool",
  appGraphicsStatus: "app:graphics-status",
  appInstallation: "app:installation",
  appDetectEditors: "app:detect-editors",
  appChooseEditor: "app:choose-editor",
  repositoryOpenEditor: "repository:open-editor",
  appTakeNavigation: "app:take-navigation",
  repositoryCommitTemplate: "repository:commit-template",
  repositoryPreviewDiscard: "repository:preview-discard",
  repositoryPreviewDiscardPartial: "repository:preview-discard-partial",
  repositoryApplyDiscard: "repository:apply-discard",
  repositoryListRecovery: "repository:list-recovery",
  repositoryRestoreContent: "repository:restore-content",
  repositoryExportRecoveryFile: "repository:export-recovery-file",
  repositoryInspectIgnore: "repository:inspect-ignore",
  repositoryAddIgnore: "repository:add-ignore",
  repositoryStopTracking: "repository:stop-tracking",
  repositoryUpdateMetadata: "repository:update-metadata",
  repositoryReveal: "repository:reveal",
  repositoryPreviewPartial: "repository:previewPartial",
  repositoryApplyPartial: "repository:applyPartial",
  operationsList: "operations:list",
  operationsCancel: "operations:cancel",
  operationsRetry: "operations:retry",
  appGetGitEngine: "app:getGitEngine",
  appCopyText: "app:copy-text",
  appWindowControl: "app:windowControl",
  appDebug: "app:debug",
  appGetGlobalGitUser: "app:getGlobalGitUser",

  identityList: "identity:list",
  identityReorder: "identity:reorder",
  identityGetActive: "identity:getActive",
  identityCreate: "identity:create",
  identityUpdate: "identity:update",
  identityDelete: "identity:delete",
  identityPreviewDelete: "identity:previewDelete",
  identityDuplicate: "identity:duplicate",
  identityInspectGit: "identity:inspectGit",
  identityReapplyGlobal: "identity:reapplyGlobal",
  repositoryApplyProfile: "repository:applyProfile",
  repositoryClearLocalCommitConfig: "repository:clearLocalCommitConfig",
  repositoryAssignProfile: "repository:assignProfile",
  repositorySuggestProfile: "repository:suggestProfile",
  identitySetActive: "identity:setActive",
  identityAssignSshKey: "identity:assignSshKey",
  identityConfigureSigning: "identity:configureSigning",

  repositoryList: "repository:list",
  repositoryReviewTrust: "repository:reviewTrust",
  repositoryPendingTrust: "repository:pendingTrust",
  repositoryRespondTrust: "repository:respondTrust",
  repositoryOpen: "repository:open",
  repositoryRelocate: "repository:relocate",
  repositoryInit: "repository:init",
  repositoryRemove: "repository:remove",
  repositoryStatus: "repository:status",
  repositoryHistory: "repository:history",
  repositoryReferenceUrl: "repository:referenceUrl",
  repositoryPreviewCommit: "repository:previewCommit",
  repositoryForgetRecovery: "repository:forgetRecovery",
  repositoryInspectCommit: "repository:inspectCommit",
  repositoryCommitSignature: "repository:commitSignature",
  repositoryWorkingDiff: "repository:workingDiff",
  repositoryCommitDiff: "repository:commitDiff",
  repositoryImagePreview: "repository:imagePreview",
  repositoryChooseFolder: "repository:chooseFolder",
  repositoryWatch: "repository:watch",
  repositoryStage: "repository:stage",
  repositoryUnstage: "repository:unstage",
  repositoryCommit: "repository:commit",
  repositoryListBranches: "repository:listBranches",
  repositoryCreateBranch: "repository:createBranch",
  repositoryCheckoutBranch: "repository:checkoutBranch",
  repositoryDeleteBranch: "repository:deleteBranch",
  repositoryRenameBranch: "repository:renameBranch",
  repositoryVerifyTag: "repository:verify-tag",
  repositoryListTags: "repository:listTags",
  repositoryCreateTag: "repository:createTag",
  repositoryDeleteTag: "repository:deleteTag",
  repositoryCheckoutTag: "repository:checkoutTag",

  sshListKeys: "ssh:listKeys",
  sshImportKey: "ssh:importKey",
  sshGenerateKey: "ssh:generateKey",
  sshGetAgentStatus: "ssh:getAgentStatus",
  sshUnlockKey: "ssh:unlockKey",
  sshLockKey: "ssh:lockKey",
  sshTestConnection: "ssh:testConnection",
  sshPendingHostTrust: "ssh:pendingHostTrust",
  sshRespondHostTrust: "ssh:respondHostTrust",
  sshChoosePrivateKey: "ssh:choosePrivateKey",
  sshChoosePublicKey: "ssh:choosePublicKey",
  sshChooseKeyDestination: "ssh:chooseKeyDestination",

  credentialsGetSecretMetadata: "credentials:getSecretMetadata",
  credentialsUnlockActiveKey: "credentials:unlockActiveKey",
  credentialsForgetActivePassphrase: "credentials:forgetActivePassphrase",

  settingsResolve: "settings:resolve",
  settingsSet: "settings:set",
  settingsReset: "settings:reset",
  settingsChooseBackgroundImage: "settings:choose-background-image",
  settingsPreviewGlobalAppearance: "settings:preview-global-appearance",
  sessionsOpen: "sessions:open",
  sessionsChange: "sessions:change",
  sessionsReset: "sessions:reset",
  sessionsReadyToClose: "sessions:readyToClose",
} as const;

export const IPC_EVENTS = {
  updateChanged: "updates:changed",
  repositoryTrustChanged: "event:repositoryTrustChanged",
  sshHostTrustChanged: "event:sshHostTrustChanged",
  navigation: "app:navigation",
  operationsChanged: "event:operationsChanged",
  identityChanged: "event:identityChanged",
  repositoriesChanged: "event:repositoriesChanged",
  repositoryChanged: "event:repositoryChanged",
  settingChanged: "event:settingChanged",
  flushRequested: "event:flushRequested",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

type EventSubscriptions = {
  [IPC_EVENTS.updateChanged]: EdaApi["events"]["onUpdateChanged"];
  [IPC_EVENTS.repositoryTrustChanged]: EdaApi["events"]["onRepositoryTrustChanged"];
  [IPC_EVENTS.sshHostTrustChanged]: EdaApi["events"]["onSshHostTrustChanged"];
  [IPC_EVENTS.navigation]: EdaApi["events"]["onNavigation"];
  [IPC_EVENTS.operationsChanged]: EdaApi["events"]["onOperationsChanged"];
  [IPC_EVENTS.identityChanged]: EdaApi["events"]["onIdentityChanged"];
  [IPC_EVENTS.repositoriesChanged]: EdaApi["events"]["onRepositoriesChanged"];
  [IPC_EVENTS.repositoryChanged]: EdaApi["events"]["onRepositoryChanged"];
  [IPC_EVENTS.settingChanged]: EdaApi["events"]["onSettingChanged"];
  [IPC_EVENTS.flushRequested]: EdaApi["events"]["onFlushRequested"];
};

export type IpcEvent = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

export type IpcEventArgs = {
  [K in IpcEvent]: Parameters<Parameters<EventSubscriptions[K]>[0]>;
};
