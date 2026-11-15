import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import type { EdaApi, IpcEvent, IpcEventArgs } from "@shared/ipc";

const api: EdaApi = {
  updates: {
    state: () => ipcRenderer.invoke(IPC_CHANNELS.updatesState),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updatesCheck),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.updatesDownload),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.updatesInstall),
  },
  gitlabSelfHosted: {
    profile: (profileId, baseUrl) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitlabSelfHostedProfile, profileId, baseUrl),
    status: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.gitlabSelfHostedStatus, profileId),
    connect: (profileId, baseUrl, token, ignoreTlsErrors) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gitlabSelfHostedConnect,
        profileId,
        baseUrl,
        token,
        ignoreTlsErrors,
      ),
    cancel: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.gitlabSelfHostedCancel, profileId),
    disconnect: (profileId, baseUrl) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitlabSelfHostedDisconnect, profileId, baseUrl),
    openTokenSettings: (profileId, baseUrl, form) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitlabSelfHostedOpenTokenSettings, profileId, baseUrl, form),
    openProfile: (profileId, baseUrl) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitlabSelfHostedOpenProfile, profileId, baseUrl),
    repositories: (profileId, baseUrl, page) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitlabSelfHostedRepositories, profileId, baseUrl, page),
  },
  gitlab: {
    repositories: (profileId, page) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitlabRepositories, profileId, page),
    profile: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.gitlabProfile, profileId),
    status: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.gitlabStatus, profileId),
    begin: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.gitlabBegin, profileId),
    poll: (profileId, id) => ipcRenderer.invoke(IPC_CHANNELS.gitlabPoll, profileId, id),
    cancel: (profileId, id) => ipcRenderer.invoke(IPC_CHANNELS.gitlabCancel, profileId, id),
    openAuthorization: (profileId, id) =>
      ipcRenderer.invoke(IPC_CHANNELS.gitlabOpenAuthorization, profileId, id),
    openProfile: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.gitlabOpenProfile, profileId),
    disconnect: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.gitlabDisconnect, profileId),
  },
  github: {
    repositories: (profileId, page) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubRepositories, profileId, page),
    maintainerProfile: () => ipcRenderer.invoke(IPC_CHANNELS.githubMaintainerProfile),
    status: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.githubStatus, profileId),
    profile: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.githubProfile, profileId),
    openProfile: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.githubOpenProfile, profileId),
    begin: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.githubBegin, profileId),
    poll: (profileId, id) => ipcRenderer.invoke(IPC_CHANNELS.githubPoll, profileId, id),
    cancel: (profileId, id) => ipcRenderer.invoke(IPC_CHANNELS.githubCancel, profileId, id),
    openVerification: (profileId, id) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubOpenVerification, profileId, id),
    disconnect: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.githubDisconnect, profileId),
  },
  avatars: {
    get: (email) => ipcRenderer.invoke(IPC_CHANNELS.avatarGet, email),
    getCommit: (repositoryId, email) =>
      ipcRenderer.invoke(IPC_CHANNELS.avatarCommitGet, repositoryId, email),
  },
  backgroundFetch: {
    inspect: (id) => ipcRenderer.invoke(IPC_CHANNELS.backgroundFetchInspect, id),
    configure: (id, minutes) =>
      ipcRenderer.invoke(IPC_CHANNELS.backgroundFetchConfigure, id, minutes),
    retry: (id, remote) => ipcRenderer.invoke(IPC_CHANNELS.backgroundFetchRetry, id, remote),
  },
  pull: {
    preference: (id) => ipcRenderer.invoke(IPC_CHANNELS.pullPreference, id),
    setPreference: (id, strategy) =>
      ipcRenderer.invoke(IPC_CHANNELS.pullSetPreference, id, strategy),
    prepare: (request) => ipcRenderer.invoke(IPC_CHANNELS.pullPrepare, request),
    execute: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.pullExecute, id, token),
  },
  rebase: {
    prepare: (id, action, onto, interactive) =>
      ipcRenderer.invoke(IPC_CHANNELS.rebasePrepare, id, action, onto, interactive),
    execute: (id, token, plan, message) =>
      ipcRenderer.invoke(IPC_CHANNELS.rebaseExecute, id, token, plan, message),
  },
  replay: {
    prepare: (id, kind, action, commits, mainline) =>
      ipcRenderer.invoke(IPC_CHANNELS.replayPrepare, id, kind, action, commits, mainline),
    execute: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.replayExecute, id, token),
  },
  reset: {
    prepare: (id, target, mode) => ipcRenderer.invoke(IPC_CHANNELS.resetPrepare, id, target, mode),
    execute: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.resetExecute, id, token),
  },
  historyRecovery: {
    resumeBranchCheckout: (id, recordId, phase) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyResumeBranchCheckout, id, recordId, phase),
    dismissUnstarted: (id, recordId) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyDismissUnstarted, id, recordId),
    resumeConfiguration: (id, recordId, direction) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyResumeConfiguration, id, recordId, direction),
    resumeIndex: (id, recordId, direction) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyResumeIndex, id, recordId, direction),
    resumeReset: (id, recordId, publishedCommits) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyResumeReset, id, recordId, publishedCommits),
    reconcile: (id, recordId, state) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyReconcile, id, recordId, state),
    reversals: (id) => ipcRenderer.invoke(IPC_CHANNELS.historyReversals, id),
    reverse: (id, recordId, direction, publishedCommits) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyReverse, id, recordId, direction, publishedCommits),
    list: (id, source, offset) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyRecoveryList, id, source, offset),
    inspect: (id, oid) => ipcRenderer.invoke(IPC_CHANNELS.historyRecoveryInspect, id, oid),
    restore: (id, token, name) =>
      ipcRenderer.invoke(IPC_CHANNELS.historyRecoveryRestore, id, token, name),
  },
  stashes: {
    prepareBranch: (id, token, name) =>
      ipcRenderer.invoke(IPC_CHANNELS.stashesPrepareBranch, id, token, name),
    createBranch: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.stashesCreateBranch, id, token),
    prepareFile: (id, token, area, path) =>
      ipcRenderer.invoke(IPC_CHANNELS.stashesPrepareFile, id, token, area, path),
    restoreFile: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.stashesRestoreFile, id, token),
    apply: (id, token, pop, restoreIndex) =>
      ipcRenderer.invoke(IPC_CHANNELS.stashesApply, id, token, pop, restoreIndex),
    list: (id) => ipcRenderer.invoke(IPC_CHANNELS.stashesList, id),
    create: (id, message, contents, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.stashesCreate, id, message, contents, options),
    inspect: (id, selector, oid) =>
      ipcRenderer.invoke(IPC_CHANNELS.stashesInspect, id, selector, oid),
    drop: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.stashesDrop, id, token),
    rename: (id, token, name) => ipcRenderer.invoke(IPC_CHANNELS.stashesRename, id, token, name),
  },
  workflows: {
    finishStash: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.workflowFinishStash, id, token),
    prepareStart: (id, source, mode) =>
      ipcRenderer.invoke(IPC_CHANNELS.workflowPrepareStart, id, source, mode),
    startMerge: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.workflowStartMerge, id, token),
    prepareAbort: (id) => ipcRenderer.invoke(IPC_CHANNELS.workflowPrepareAbort, id),
    abortMerge: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.workflowAbortMerge, id, token),
    prepareMerge: (id) => ipcRenderer.invoke(IPC_CHANNELS.workflowPrepareMerge, id),
    continueMerge: (repositoryId, id, message) =>
      ipcRenderer.invoke(IPC_CHANNELS.workflowContinueMerge, repositoryId, id, message),
  },
  conflicts: {
    external: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.conflictExternal, id, token),
    inspect: (id, path) => ipcRenderer.invoke(IPC_CHANNELS.conflictInspect, id, path),
    resolve: (request) => ipcRenderer.invoke(IPC_CHANNELS.conflictResolve, request),
  },
  remotes: {
    inspect: (id) => ipcRenderer.invoke(IPC_CHANNELS.remotesInspect, id),
    listTags: (request) => ipcRenderer.invoke(IPC_CHANNELS.remotesListTags, request),
    change: (id, change) => ipcRenderer.invoke(IPC_CHANNELS.remotesChange, id, change),
    track: (id, branch, upstream) =>
      ipcRenderer.invoke(IPC_CHANNELS.remotesTrack, id, branch, upstream),
    fetch: (request) => ipcRenderer.invoke(IPC_CHANNELS.remotesFetch, request),
    preparePush: (request) => ipcRenderer.invoke(IPC_CHANNELS.remotesPreparePush, request),
    push: (id, token, credentials) =>
      ipcRenderer.invoke(IPC_CHANNELS.remotesPush, id, token, credentials),
    clone: (request) => ipcRenderer.invoke(IPC_CHANNELS.remotesClone, request),
  },
  operations: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.operationsList),
    cancel: (id) => ipcRenderer.invoke(IPC_CHANNELS.operationsCancel, id),
    retry: (id) => ipcRenderer.invoke(IPC_CHANNELS.operationsRetry, id),
  },
  app: {
    version: __EDA_BUILD_INFO__,
    installation: () => ipcRenderer.invoke(IPC_CHANNELS.appInstallation),
    copyText: (value) => ipcRenderer.invoke(IPC_CHANNELS.appCopyText, value),
    debug: (action) => ipcRenderer.invoke(IPC_CHANNELS.appDebug, action),
    detectMergeTools: () => ipcRenderer.invoke(IPC_CHANNELS.appDetectMergeTools),
    chooseMergeTool: () => ipcRenderer.invoke(IPC_CHANNELS.appChooseMergeTool),
    graphicsStatus: () => ipcRenderer.invoke(IPC_CHANNELS.appGraphicsStatus),
    detectEditors: () => ipcRenderer.invoke(IPC_CHANNELS.appDetectEditors),
    chooseEditor: () => ipcRenderer.invoke(IPC_CHANNELS.appChooseEditor),
    takeNavigation: () => ipcRenderer.invoke(IPC_CHANNELS.appTakeNavigation),
    platform:
      process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux",
    getGitEngine: () => ipcRenderer.invoke(IPC_CHANNELS.appGetGitEngine),
    windowControl: (action) => ipcRenderer.invoke(IPC_CHANNELS.appWindowControl, action),
    getGlobalGitUser: () => ipcRenderer.invoke(IPC_CHANNELS.appGetGlobalGitUser),
  },

  identity: {
    listGpgSigningKeys: () => ipcRenderer.invoke(IPC_CHANNELS.identityListGpgSigningKeys),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.identityList),
    reorder: (ids) => ipcRenderer.invoke(IPC_CHANNELS.identityReorder, ids),
    getActive: () => ipcRenderer.invoke(IPC_CHANNELS.identityGetActive),
    create: (draft, options) => ipcRenderer.invoke(IPC_CHANNELS.identityCreate, draft, options),
    update: (id, draft) => ipcRenderer.invoke(IPC_CHANNELS.identityUpdate, id, draft),
    previewDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.identityPreviewDelete, id),
    delete: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.identityDelete, id, token),
    duplicate: (id, options) => ipcRenderer.invoke(IPC_CHANNELS.identityDuplicate, id, options),
    inspectGit: (repositoryId) => ipcRenderer.invoke(IPC_CHANNELS.identityInspectGit, repositoryId),
    reapplyGlobal: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.identityReapplyGlobal, profileId),
    setActive: (id) => ipcRenderer.invoke(IPC_CHANNELS.identitySetActive, id),
    assignSshKey: (path, profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.identityAssignSshKey, path, profileId),
    configureSigning: (signing, profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.identityConfigureSigning, signing, profileId),
  },

  repository: {
    reviewTrust: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryReviewTrust, id),
    pendingTrust: () => ipcRenderer.invoke(IPC_CHANNELS.repositoryPendingTrust),
    respondTrust: (id, trust) => ipcRenderer.invoke(IPC_CHANNELS.repositoryRespondTrust, id, trust),
    ignoredFiles: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryIgnoredFiles, id),
    openEditor: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryOpenEditor, id),
    openDropped: (file) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryOpen, webUtils.getPathForFile(file)),
    commitTemplate: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryCommitTemplate, id),
    previewDiscardPartial: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryPreviewDiscardPartial, request),
    exportRecoveryFile: (id, snapshot, path, stage) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryExportRecoveryFile, id, snapshot, path, stage),
    previewDiscard: (id, paths) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryPreviewDiscard, id, paths),
    applyDiscard: (id, token) => ipcRenderer.invoke(IPC_CHANNELS.repositoryApplyDiscard, id, token),
    listRecovery: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryListRecovery, id),
    restoreContent: (id, snapshot) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryRestoreContent, id, snapshot),
    inspectIgnore: (id, path, kind) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryInspectIgnore, id, path, kind),
    addIgnore: (id, path, kind) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryAddIgnore, id, path, kind),
    stopTracking: (id, path) => ipcRenderer.invoke(IPC_CHANNELS.repositoryStopTracking, id, path),
    updateMetadata: (id, metadata) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryUpdateMetadata, id, metadata),
    reveal: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryReveal, id),
    previewPartial: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryPreviewPartial, request),
    applyPartial: (repositoryId, token) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryApplyPartial, repositoryId, token),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.repositoryList),
    open: (path) => ipcRenderer.invoke(IPC_CHANNELS.repositoryOpen, path),
    relocate: (id, path) => ipcRenderer.invoke(IPC_CHANNELS.repositoryRelocate, id, path),
    init: (path, options) => ipcRenderer.invoke(IPC_CHANNELS.repositoryInit, path, options),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryRemove, id),
    status: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryStatus, id),
    history: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryHistory, request),
    referenceUrl: (id, kind, name) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryReferenceUrl, id, kind, name),
    previewCommit: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryPreviewCommit, id),
    forgetRecovery: (id, snapshot) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryForgetRecovery, id, snapshot),
    inspectCommit: (id, oid, refreshSignature) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryInspectCommit, id, oid, refreshSignature),
    commitSignature: (id, oid) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryCommitSignature, id, oid),
    workingDiff: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryWorkingDiff, request),
    commitDiff: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryCommitDiff, request),
    imagePreview: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryImagePreview, request),
    chooseFolder: () => ipcRenderer.invoke(IPC_CHANNELS.repositoryChooseFolder),
    watch: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryWatch, id),
    applyProfile: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryApplyProfile, id),
    clearLocalCommitConfig: (id, group) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryClearLocalCommitConfig, id, group),
    assignProfile: (id, targetId, move) =>
      ipcRenderer.invoke(IPC_CHANNELS.repositoryAssignProfile, id, targetId, move),
    suggestProfile: (path) => ipcRenderer.invoke(IPC_CHANNELS.repositorySuggestProfile, path),

    stage: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryStage, request),
    unstage: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryUnstage, request),
    commit: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryCommit, request),

    listBranches: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryListBranches, id),
    createBranch: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryCreateBranch, request),
    checkoutBranch: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryCheckoutBranch, request),
    deleteBranch: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryDeleteBranch, request),
    renameBranch: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryRenameBranch, request),

    verifyTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryVerifyTag, request),
    listTags: (id) => ipcRenderer.invoke(IPC_CHANNELS.repositoryListTags, id),
    createTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryCreateTag, request),
    deleteTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryDeleteTag, request),
    checkoutTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.repositoryCheckoutTag, request),
  },

  ssh: {
    listKeys: () => ipcRenderer.invoke(IPC_CHANNELS.sshListKeys),
    importKey: (path) => ipcRenderer.invoke(IPC_CHANNELS.sshImportKey, path),
    generateKey: (request) => ipcRenderer.invoke(IPC_CHANNELS.sshGenerateKey, request),
    getAgentStatus: () => ipcRenderer.invoke(IPC_CHANNELS.sshGetAgentStatus),
    unlockKey: (request, passphrase) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshUnlockKey, request, passphrase),
    lockKey: (keyPath) => ipcRenderer.invoke(IPC_CHANNELS.sshLockKey, keyPath),
    testConnection: (host, keyPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshTestConnection, host, keyPath),
    pendingHostTrust: () => ipcRenderer.invoke(IPC_CHANNELS.sshPendingHostTrust),
    respondHostTrust: (id, trust) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshRespondHostTrust, id, trust),
    choosePrivateKey: () => ipcRenderer.invoke(IPC_CHANNELS.sshChoosePrivateKey),
    choosePublicKey: () => ipcRenderer.invoke(IPC_CHANNELS.sshChoosePublicKey),
    chooseKeyDestination: () => ipcRenderer.invoke(IPC_CHANNELS.sshChooseKeyDestination),
  },

  credentials: {
    getSecretMetadata: (profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.credentialsGetSecretMetadata, profileId),
    unlockActiveKey: (request, passphrase, profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.credentialsUnlockActiveKey, request, passphrase, profileId),
    forgetActivePassphrase: (profileId) =>
      ipcRenderer.invoke(IPC_CHANNELS.credentialsForgetActivePassphrase, profileId),
  },

  settings: {
    resolve: (key, context) => ipcRenderer.invoke(IPC_CHANNELS.settingsResolve, key, context),
    set: (key, scope, value) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, key, scope, value),
    reset: (key, scope) => ipcRenderer.invoke(IPC_CHANNELS.settingsReset, key, scope),
    chooseBackgroundImage: () => ipcRenderer.invoke(IPC_CHANNELS.settingsChooseBackgroundImage),
    previewGlobalAppearance: (enabled) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsPreviewGlobalAppearance, enabled),
  },

  events: {
    onUpdateChanged: (handler) => subscribe(IPC_EVENTS.updateChanged, handler),
    onRepositoryTrustChanged: (handler) => subscribe(IPC_EVENTS.repositoryTrustChanged, handler),
    onSshHostTrustChanged: (handler) => subscribe(IPC_EVENTS.sshHostTrustChanged, handler),
    onNavigation: (handler) => subscribe(IPC_EVENTS.navigation, handler),
    onOperationsChanged: (handler) => subscribe(IPC_EVENTS.operationsChanged, handler),
    onFlushRequested: (handler) => subscribe(IPC_EVENTS.flushRequested, handler),
    onIdentityChanged: (handler) => subscribe(IPC_EVENTS.identityChanged, handler),
    onRepositoriesChanged: (handler) => subscribe(IPC_EVENTS.repositoriesChanged, handler),
    onRepositoryChanged: (handler) => subscribe(IPC_EVENTS.repositoryChanged, handler),
    onSettingChanged: (handler) => subscribe(IPC_EVENTS.settingChanged, handler),
  },
  sessions: {
    open: () => ipcRenderer.invoke(IPC_CHANNELS.sessionsOpen),
    change: (context, change) => ipcRenderer.invoke(IPC_CHANNELS.sessionsChange, context, change),
    reset: (context) => ipcRenderer.invoke(IPC_CHANNELS.sessionsReset, context),
    readyToClose: (nonce) => ipcRenderer.invoke(IPC_CHANNELS.sessionsReadyToClose, nonce),
  },
};

function subscribe<C extends IpcEvent>(
  channel: C,
  handler: (...args: NoInfer<IpcEventArgs[C]>) => void,
): () => void {
  const listener = (_event: unknown, ...args: unknown[]) => handler(...(args as IpcEventArgs[C]));
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("eda", api);

  const syncZoom = () => {
    document.documentElement.style.setProperty("--window-zoom", String(webFrame.getZoomFactor()));
  };

  window.addEventListener("DOMContentLoaded", syncZoom, { once: true });
  window.addEventListener("resize", syncZoom);
}
