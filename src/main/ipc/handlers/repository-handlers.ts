import { keyError } from "../../providers/public-signing-keys";
import { isFlowConfig, isFlowPlan, flowKinds, type FlowAction } from "@shared/workflows/gitflow";
import { isOneOf } from "@shared/validation";
import type { WorktreeAction, SubmoduleAction } from "@shared/repository/repository-write";
import type {
  DiffDisplayOptions,
  PatchExportRequest,
  PublicKeyRequest,
} from "@shared/repository/repository-read";
import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import type { PartialStageRequest } from "@shared/repository/partial-stage";
import type { InitRepositoryOptions } from "@shared/repository/repository";
import {
  isHistorySearchField,
  MAX_HISTORY_PAGE_SIZE,
  submoduleUpdateModes,
} from "@shared/repository/repository-read";
import { shell } from "electron";
import { readRegularFile } from "../../filesystem/read-regular-file";
import { saveFile } from "../../filesystem/save-file";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { repositoryCapabilities } from "../../repo/lifecycle/repository-capabilities";
import { RepositoryWatcher } from "../../repo/lifecycle/repository-watcher";
import type { ImagePreviewRequest } from "@shared/repository/image-preview";
import { readImagePreview } from "../../repo/working-tree/image-preview";
import type { Services } from "../../services";
import { showOpenDialog, showSaveDialog } from "../dialogs";
import { invalidRequest } from "../../request-errors";
import { broadcast, handle, withRepositoryChange } from "../transport";
import {
  optionalInteger,
  requireAbsolutePath,
  requireId,
  requireRecord,
  requireString,
  requireStringArray,
} from "../validate";

function diffDisplayOptions(input: Record<string, unknown>): DiffDisplayOptions {
  const context = input["context"];
  const ignoreWhitespace = input["ignoreWhitespace"];
  if (
    (context !== undefined && context !== "expanded" && context !== "full") ||
    (ignoreWhitespace !== undefined && typeof ignoreWhitespace !== "boolean")
  )
    throw invalidRequest(errorText("main.repositoryHandlers.invalidDiffDisplay"));
  return { ...(context && { context }), ...(ignoreWhitespace && { ignoreWhitespace }) };
}

export function registerRepositoryHandlers(services: Services): void {
  const { git, repositories } = services;

  handle(IPC_CHANNELS.repositoryForgetSigningKey, async (_e, rawId, fingerprint) => {
    const id = requireId(rawId);
    services.commitSignatures.forgetKey(
      id,
      requireString(fingerprint, t("diff.commitDetails.signatureKey"), 64),
    );
    broadcast(IPC_EVENTS.repositoryChanged, id);
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositoryCancelKeyDiscovery, async (_e, id) => {
    services.commitSignatures.cancelDiscovery(requireId(id));
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositorySignerDecisions, async (_e, id) =>
    ok(services.commitSignatures.listSigners(requireId(id))),
  );
  handle(IPC_CHANNELS.repositoryDecideSigner, async (_e, rawId, raw, remove) => {
    const id = requireId(rawId);
    const input = requireRecord(raw, t("diff.commitDetails.signatureTrust"));
    const scope = input["scope"];
    const decision = input["decision"];
    if (
      (scope !== "profile" && scope !== "repository") ||
      (decision !== "trusted" && decision !== "distrusted") ||
      typeof remove !== "boolean"
    )
      throw keyError();
    services.commitSignatures.decide(
      id,
      {
        fingerprint: requireString(input["fingerprint"], t("diff.commitDetails.signatureKey"), 100),
        identity: requireString(input["identity"], t("diff.commitDetails.signatureSigner"), 320),
        scope,
        decision,
      },
      remove,
    );
    broadcast(IPC_EVENTS.repositoryChanged, id);
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositoryDiscoverSigningKey, async (_e, rawId, rawOid, raw) => {
    const id = requireId(rawId);
    const oid = requireString(rawOid, t("fields.commitObjectId"), 64);
    const input = requireRecord(raw, t("diff.commitDetails.signatureKey"));
    let request: PublicKeyRequest;
    if (input["source"] === "automatic") request = { source: "automatic" };
    else if (input["source"] === "github")
      request = {
        source: "github",
        account: requireString(input["account"], t("signature.github"), 39),
      };
    else if (input["source"] === "keyserver")
      request = {
        source: "keyserver",
        server: requireString(input["server"], t("signature.server"), 2048),
      };
    else if (input["source"] === "manual")
      request = {
        source: "manual",
        armoredKey: requireString(
          input["armoredKey"],
          t("diff.commitDetails.signatureKey"),
          256 * 1024,
        ),
      };
    else throw keyError();
    const result = await services.commitSignatures.discover(id, oid, request);
    broadcast(IPC_EVENTS.repositoryChanged, id);
    return ok(result);
  });

  handle(IPC_CHANNELS.repositoryReviewTrust, async (_event, rawId) => {
    const repository = repositories.resolveActiveRepository(requireId(rawId));
    await services.identity.serialize(async () => {
      repositories.resolveActiveRepository(repository.id);
      await git.trust?.authorize(repository.path, false, true);
    });
    broadcast(IPC_EVENTS.repositoryChanged, repository.id);
    broadcast(IPC_EVENTS.repositoriesChanged);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryPendingTrust, async (event) => {
    if (event.senderFrame !== event.sender.mainFrame)
      throw invalidRequest(errorText("main.repositoryTrust.invalidResponse"));
    return ok(services.repositoryTrust.current(event.sender.id));
  });

  handle(IPC_CHANNELS.repositoryRespondTrust, async (event, rawId, rawTrust) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof rawTrust !== "boolean")
      throw invalidRequest(errorText("main.repositoryTrust.invalidResponse"));
    if (!services.repositoryTrust.respond(event.sender.id, requireId(rawId), rawTrust))
      throw invalidRequest(errorText("main.repositoryTrust.expiredRequest"));
    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryReferenceUrl, async (_e, rawId, kind, rawName) => {
    const repositoryId = requireId(rawId);

    if (kind !== "commit" && kind !== "branch" && kind !== "remote-branch" && kind !== "tag")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseAReferenceKind"));

    const name = requireString(rawName, t("fields.referenceName"), 255);

    return ok(await services.repositoryReader.referenceUrl(repositoryId, kind, name));
  });

  handle(IPC_CHANNELS.repositoryPreviewCommit, async (_e, id) =>
    ok(await services.writer.previewCommit(requireId(id))),
  );

  handle(IPC_CHANNELS.repositoryForgetRecovery, async (_e, id, snapshot) => {
    await services.writer.forgetRecovery(requireId(id), requireId(snapshot));
    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryIgnoredFiles, async (_event, rawId) =>
    ok(await services.repositoryReader.ignoredFiles(requireId(rawId))),
  );

  handle(IPC_CHANNELS.repositoryCommitTemplate, async (_event, rawId) =>
    ok(await services.repositoryReader.commitTemplate(requireId(rawId))),
  );

  handle(
    IPC_CHANNELS.repositoryExportRecoveryFile,
    async (event, rawId, rawSnapshot, rawPath, stage) => {
      const path = requireString(rawPath, t("fields.savedFile"));

      if (stage !== undefined && (typeof stage !== "number" || ![0, 1, 2, 3].includes(stage)))
        throw invalidRequest(errorText("main.repositoryHandlers.chooseASavedIndexStage"));

      const bytes = services.writer.savedRecoveryFile(
        requireId(rawId),
        requireId(rawSnapshot),
        path,
        stage,
      );

      const options = {
        title: t("main.repositoryHandlers.saveRecoveredFileCopy"),
        defaultPath: `${basename(path)}.recovered`,
      };

      const destination = await showSaveDialog(event, options);

      if (destination.canceled || !destination.filePath) return ok(false);

      await writeFile(destination.filePath, bytes);

      return ok(true);
    },
  );

  handle(IPC_CHANNELS.repositoryPreviewDiscard, async (_e, id, paths) =>
    ok(
      await services.writer.previewDiscard(
        requireId(id),
        requireStringArray(paths, t("fields.filesToDiscard"), 256),
      ),
    ),
  );

  handle(IPC_CHANNELS.repositoryListRecovery, async (_e, id) =>
    ok(services.writer.listRecovery(requireId(id))),
  );

  handle(IPC_CHANNELS.repositoryApplyDiscard, async (_e, rawId, token) => {
    const id = requireId(rawId);
    await withRepositoryChange(id, async () => services.writer.applyDiscard(id, requireId(token)));

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryRestoreContent, async (_e, rawId, snapshot) => {
    const id = requireId(rawId);
    await withRepositoryChange(id, async () =>
      services.writer.restoreContent(id, requireId(snapshot)),
    );

    return ok(undefined);
  });

  const ignoreKind = (kind: unknown) => {
    if (kind !== "path" && kind !== "extension" && kind !== "directory")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseAnIgnoreRuleType"));
    return kind;
  };

  handle(IPC_CHANNELS.repositoryInspectIgnore, async (_e, id, path, kind) =>
    ok(
      await services.writer.inspectIgnore(
        requireId(id),
        requireString(path, t("fields.filePath")),
        ignoreKind(kind),
      ),
    ),
  );

  handle(IPC_CHANNELS.repositoryAddIgnore, async (_e, id, path, kind) => {
    const repositoryId = requireId(id);

    await withRepositoryChange(repositoryId, async () =>
      services.writer.addIgnore(
        repositoryId,
        requireString(path, t("fields.filePath")),
        ignoreKind(kind),
      ),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryStopTracking, async (_e, id, path) => {
    const repositoryId = requireId(id);
    await withRepositoryChange(repositoryId, async () =>
      services.writer.stopTracking(repositoryId, requireString(path, t("fields.filePath"))),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryUpdateMetadata, async (_event, rawId, rawMetadata) => {
    const metadata = requireRecord(rawMetadata, t("main.repositoryHandlers.repositoryMetadata"));

    if (typeof metadata["favourite"] !== "boolean")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseAFavouriteState"));

    repositories.updateMetadata(
      requireId(rawId),
      requireString(metadata["name"], t("fields.repositoryName")),
      metadata["favourite"],
    );

    broadcast(IPC_EVENTS.repositoriesChanged);

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryReveal, async (_event, rawId) => {
    const repository = repositories.resolveActiveRepository(requireId(rawId));
    shell.showItemInFolder(repository.path);
    return ok(undefined);
  });

  const watcher = new RepositoryWatcher((repositoryId, warning) =>
    broadcast(IPC_EVENTS.repositoryChanged, repositoryId, warning),
  );

  let watchGeneration = 0;
  services.identity.onChange(() => {
    watchGeneration++;
    watcher.closeAll();
  });

  handle(IPC_CHANNELS.repositoryWatch, async (_e, rawId) => {
    const generation = ++watchGeneration;
    watcher.closeAll();
    if (rawId === null) return ok(undefined);

    const repository = repositories.resolveActiveRepository(
      requireId(rawId, t("fields.repositoryId")),
    );

    const metadata = await git.trust?.checked(repository.path);
    if (generation === watchGeneration) watcher.watch(repository.id, repository.path, metadata);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryApplyProfile, async (_event, rawId) => {
    const id = requireId(rawId);
    await withRepositoryChange(id, async () => services.writer.applyProfile(id));

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryClearLocalCommitConfig, async (_event, rawId, group) => {
    if (group !== "author" && group !== "signing" && group !== "all")
      throw invalidRequest(
        errorText("main.repositoryHandlers.chooseAuthorSigningOrBothLocalCommitSettings"),
      );

    const id = requireId(rawId);
    await withRepositoryChange(id, async () => services.writer.clearLocalCommitConfig(id, group));

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryAssignProfile, async (_event, rawId, rawTarget, rawMove) => {
    if (typeof rawMove !== "boolean")
      throw invalidRequest(
        errorText("main.repositoryHandlers.chooseWhetherToKeepTheSourceMembership"),
      );

    const id = await services.profiles.assignRepository(
      requireId(rawId),
      requireId(rawTarget),
      rawMove,
    );

    broadcast(IPC_EVENTS.repositoriesChanged);

    return ok(id);
  });

  handle(IPC_CHANNELS.repositoryList, async () => ok(await repositories.listForActiveIdentity()));

  handle(IPC_CHANNELS.repositoryOpen, async (_e, rawPath) => {
    const summary = await repositories.open(requireAbsolutePath(rawPath));
    broadcast(IPC_EVENTS.repositoriesChanged);
    return ok(summary);
  });

  handle(IPC_CHANNELS.repositoryRelocate, async (_e, rawId, rawPath) => {
    const summary = await repositories.relocate(requireId(rawId), requireAbsolutePath(rawPath));
    broadcast(IPC_EVENTS.repositoriesChanged);
    return ok(summary);
  });

  handle(IPC_CHANNELS.repositoryInit, async (_e, rawPath, rawOptions) => {
    let options: InitRepositoryOptions | undefined;

    if (rawOptions !== undefined) {
      const input = requireRecord(
        rawOptions,
        t("main.repositoryHandlers.initialRepositoryOptions"),
      );

      const ignore = input["ignore"];
      const license = input["license"];

      if (
        typeof input["readme"] !== "boolean" ||
        (ignore !== "none" && ignore !== "node" && ignore !== "python") ||
        (license !== "none" && license !== "MIT")
      )
        throw invalidRequest(errorText("main.repositoryHandlers.chooseSupportedInitialFiles"));

      options = {
        branch: requireString(input["branch"], t("fields.initialBranch")),
        readme: input["readme"],
        ignore,
        license,
      };
    }

    const summary = await repositories.init(requireAbsolutePath(rawPath), options);

    broadcast(IPC_EVENTS.repositoriesChanged);

    return ok(summary);
  });

  handle(IPC_CHANNELS.repositoryRemove, async (_e, rawId) => {
    const id = requireId(rawId);
    const repository = repositories.resolveActiveRepository(id);
    repositories.remove(id);
    services.terminals.forget(repository.identityId, id);
    broadcast(IPC_EVENTS.repositoriesChanged);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryStatus, async (_e, rawId) => {
    const repository = repositories.resolveActiveRepository(
      requireId(rawId, t("fields.repositoryId")),
    );

    const [status, capabilities] = await Promise.all([
      git.status(repository.path),
      repositoryCapabilities(git, repository.path, true),
    ]);

    const workflow = await services.workflows.observe(repository.path, status);

    return ok({ ...status, capabilities, workflow });
  });

  handle(IPC_CHANNELS.repositoryHistory, async (_e, raw) => {
    const input = requireRecord(raw, t("main.repositoryHandlers.historyRequest"));

    const repository = repositories.resolveActiveRepository(
      requireId(input["repositoryId"], t("fields.repositoryId")),
    );

    const offset = optionalInteger(input["offset"], t("fields.historyOffset"), 0, 1_000_000);

    const limit = optionalInteger(
      input["limit"],
      t("fields.historyLimit"),
      1,
      MAX_HISTORY_PAGE_SIZE,
    );

    if (input["showStashes"] !== undefined && typeof input["showStashes"] !== "boolean")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseWhetherToShowStashes"));

    if (input["showInternalRefs"] !== undefined && typeof input["showInternalRefs"] !== "boolean")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseWhetherToShowInternalRefs"));

    let search;
    if (input["search"] !== undefined) {
      const filter = requireRecord(input["search"], t("historySearch.title"));
      const field = filter["field"];
      if (!isHistorySearchField(field))
        throw invalidRequest(errorText("historySearch.invalidField"));
      search = { field, text: requireString(filter["text"], t("historySearch.title")) };
    }

    return ok(
      await git.history(repository.path, {
        ...(search && { search }),
        showStashes: input["showStashes"] === true,
        showInternalRefs:
          input["showInternalRefs"] ?? services.preferences.resolve("showInternalRefs").value,
        ...(offset !== undefined && { offset }),
        ...(limit !== undefined && { limit }),
        ...(input["refs"] !== undefined && {
          refs: requireStringArray(input["refs"], t("fields.graphReferences"), 256),
        }),
        ...(input["hiddenRefs"] !== undefined && {
          hiddenRefs: requireStringArray(input["hiddenRefs"], t("fields.hiddenReferences"), 256),
        }),
      }),
    );
  });

  handle(IPC_CHANNELS.repositoryContributors, async (_e, id) =>
    ok(await services.repositoryReader.contributors(requireId(id))),
  );

  handle(IPC_CHANNELS.repositoryCommitMessage, async (_e, id, oid) =>
    ok(
      await services.repositoryReader.commitMessage(
        requireId(id),
        requireString(oid, t("fields.commitObjectId"), 64),
      ),
    ),
  );

  handle(IPC_CHANNELS.repositoryInspectCommit, async (_e, id, oid, refreshSignature) => {
    if (refreshSignature !== undefined && typeof refreshSignature !== "boolean")
      throw invalidRequest(
        errorText("main.repositoryHandlers.chooseWhetherToVerifySignatureAgain"),
      );

    return ok(
      await services.commitSignatures.inspect(
        requireId(id),
        requireString(oid, t("fields.commitObjectId"), 64),
        refreshSignature === true,
      ),
    );
  });

  handle(IPC_CHANNELS.repositoryCommitSignature, async (_e, id, oid) => {
    return ok(
      await services.commitSignatures.read(
        requireId(id),
        requireString(oid, t("fields.commitObjectId"), 64),
      ),
    );
  });

  const repositoryRequest = (raw: unknown, label: string) => {
    const input = requireRecord(raw, label);
    return { input, repositoryId: requireId(input["repositoryId"], t("fields.repositoryId")) };
  };

  handle(IPC_CHANNELS.repositoryExportPatch, async (event, raw, rawMailbox) => {
    const { input, repositoryId } = repositoryRequest(raw, t("patch.export"));
    const area = input["area"];
    const path =
      input["path"] === undefined ? undefined : requireString(input["path"], t("fields.filePath"));
    const oldPath =
      input["oldPath"] === undefined
        ? undefined
        : requireString(input["oldPath"], t("fields.filePath"));
    const oid =
      input["oid"] === undefined
        ? undefined
        : requireString(input["oid"], t("fields.commitObjectId"), 64);
    let request: PatchExportRequest;
    if (oid && area === undefined && (!oldPath || path)) {
      request = { repositoryId, oid, ...(path && { path }), ...(oldPath && { oldPath }) };
    } else if (!oid && !oldPath && path && (area === "staged" || area === "unstaged")) {
      request = { repositoryId, area, path };
    } else {
      throw invalidRequest(errorText("main.repositoryHandlers.chooseAValidDiffArea"));
    }
    const owner = repositories.resolveActiveRepository(repositoryId);
    const mailbox =
      rawMailbox === undefined ? undefined : requireRecord(rawMailbox, t("mailbox.export"));
    if (mailbox && (!oid || path)) throw invalidRequest(errorText("mailbox.range"));
    const after =
      mailbox?.["after"] === undefined
        ? undefined
        : requireString(mailbox["after"], t("mailbox.base"), 64);
    const bytes =
      mailbox && oid
        ? await services.repositoryReader.mailboxPatch(repositoryId, oid, after)
        : await services.repositoryReader.filePatch(request);
    const name = "oid" in request ? (request.path ?? request.oid.slice(0, 12)) : request.path;
    if (!bytes.length) throw invalidRequest(errorText("patch.empty"));
    const options = {
      title: t("patch.save", { path: name, bytes: bytes.length }),
      defaultPath: basename(name) + (mailbox ? ".mbox" : ".patch"),
      filters: mailbox
        ? [{ name: t("mailbox.export"), extensions: ["mbox"] }]
        : [{ name: t("patch.export"), extensions: ["patch", "diff"] }],
    };
    const result = await showSaveDialog(event, options);
    if (result.canceled || !result.filePath) return ok(false);
    repositories.assertCurrentRepository(owner);
    await saveFile(result.filePath, bytes);
    return ok(true);
  });

  handle(IPC_CHANNELS.repositoryResumeMailbox, async (_e, rawId, action, rawToken) => {
    if (action !== "continue" && action !== "abort")
      throw invalidRequest(errorText("mailbox.invalid"));
    const id = requireId(rawId);
    const token = requireString(rawToken, t("mailbox.preview"), 64);
    await withRepositoryChange(id, () => writer.mailbox(id, { action, token }));
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositoryApplyPatch, async (event, rawId, mailbox) => {
    const id = requireId(rawId);
    const owner = repositories.resolveActiveRepository(id);
    const file = await showOpenDialog(event, {
      title: t(mailbox === true ? "mailbox.apply" : "patch.apply"),
      buttonLabel: t(mailbox === true ? "mailbox.apply" : "patch.apply"),
      properties: ["openFile"],
      filters: [
        {
          name: t("patch.files"),
          extensions: mailbox === true ? ["mbox", "patch"] : ["patch", "diff"],
        },
        { name: t("patch.allFiles"), extensions: ["*"] },
      ],
    });
    if (file.canceled || !file.filePaths[0]) return ok(false);
    const { bytes } = await readRegularFile(file.filePaths[0], 32 * 1024 * 1024, () =>
      invalidRequest(errorText("patch.invalidFile")),
    );
    repositories.assertCurrentRepository(owner);
    await withRepositoryChange(id, () =>
      mailbox === true ? writer.mailbox(id, { bytes }) : writer.applyPatch(id, bytes),
    );
    return ok(true);
  });

  handle(IPC_CHANNELS.repositoryChangeSubmodule, async (_e, rawId, raw) => {
    const id = requireId(rawId);
    const input = requireRecord(raw, t("submodules.manage"));
    const kind = input["kind"];
    let action: SubmoduleAction;
    if (kind === "automatic" && typeof input["enabled"] === "boolean")
      action = { kind, enabled: input["enabled"] };
    else {
      const path = requireString(input["path"], t("submodules.path"));
      const mode = input["mode"];
      if (kind === "add")
        action = { kind, path, url: requireString(input["url"], t("submodules.url")) };
      else if (kind === "remove") action = { kind, path };
      else if (
        (kind === "update" || kind === "init" || kind === "sync") &&
        typeof input["recursive"] === "boolean" &&
        isOneOf(mode, submoduleUpdateModes)
      )
        action = { kind, path, recursive: input["recursive"], mode };
      else throw invalidRequest(errorText("submodules.invalid"));
    }
    await withRepositoryChange(id, () => services.writer.changeSubmodule(id, action));
    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositorySubmodules, async (_event, id) =>
    ok(await services.repositoryReader.submodules(requireId(id))),
  );

  handle(
    IPC_CHANNELS.repositoryRestoreRevision,
    async (_e, rawId, rawOid, rawPaths, destination) => {
      const id = requireId(rawId);
      if (destination !== "index" && destination !== "worktree" && destination !== "both")
        throw invalidRequest(errorText("revision.destination"));
      const oid = requireString(rawOid, t("fields.commitObjectId"), 64);
      const paths = requireStringArray(rawPaths, t("revision.restore"));
      await withRepositoryChange(id, () =>
        services.writer.restoreRevision(id, oid, paths, destination),
      );
      return ok(undefined);
    },
  );
  handle(IPC_CHANNELS.repositorySparseCheckout, async (_e, id) =>
    ok(await services.repositoryReader.sparseCheckout(requireId(id))),
  );
  handle(IPC_CHANNELS.repositoryChangeSparseCheckout, async (_e, rawId, action, rawPaths) => {
    if (action !== "set" && action !== "disable" && action !== "reapply")
      throw invalidRequest(errorText("sparse.invalid"));
    const id = requireId(rawId);
    const paths = requireStringArray(rawPaths, t("sparse.directories"));
    await withRepositoryChange(id, () => services.remotes.changeSparseCheckout(id, action, paths));
    return ok(undefined);
  });
  handle(IPC_CHANNELS.repositoryChangeWorktree, async (_e, rawId, raw) => {
    const id = requireId(rawId);
    const input = requireRecord(raw, t("worktrees.title"));
    const kind = input["kind"];
    let action: WorktreeAction;
    if (kind === "prune") action = { kind };
    else {
      const path = requireAbsolutePath(input["path"]);
      if (kind === "create")
        action = {
          kind,
          path,
          branch: requireString(input["branch"], t("worktrees.branch"), 255),
          ...(input["base"] !== undefined && {
            base: requireString(input["base"], t("worktrees.base"), 255),
          }),
        };
      else if (kind === "lock" || kind === "unlock") action = { kind, path };
      else if (kind === "remove" || kind === "cleanup")
        action = {
          kind,
          path,
          oid: requireString(input["oid"], t("fields.commitObjectId"), 64),
          ...(input["branch"] !== undefined && {
            branch: requireString(input["branch"], t("worktrees.branch"), 255),
          }),
        };
      else throw invalidRequest(errorText("worktrees.invalid"));
    }
    const change = () => services.writer.changeWorktree(id, action);
    const ref = await withRepositoryChange(id, () =>
      action.kind === "remove" || action.kind === "cleanup"
        ? services.terminals.whileWorktreeIdle(action.path, change)
        : change(),
    );
    broadcast(IPC_EVENTS.repositoriesChanged);
    return ok(ref);
  });
  handle(IPC_CHANNELS.repositoryFlowState, async (_e, id) =>
    ok(await services.writer.flowState(requireId(id))),
  );
  handle(IPC_CHANNELS.repositoryGitflow, async (_e, rawId, raw) => {
    const id = requireId(rawId);
    const input = requireRecord(raw, t("flow.title"));
    const kind = input["kind"];
    let action: FlowAction;
    if (kind === "configure" && isFlowConfig(input["config"]))
      action = { kind, config: input["config"] };
    else if (kind === "finish" && isFlowPlan(input["plan"])) action = { kind, plan: input["plan"] };
    else if (kind === "resume" || kind === "retain") action = { kind };
    else if (
      (kind === "start" || kind === "preview") &&
      isOneOf(input["type"], flowKinds) &&
      typeof input["retain"] === "boolean"
    )
      action = {
        kind,
        type: input["type"],
        name: requireString(input["name"], t("flow.name"), 255),
        retain: input["retain"],
      };
    else throw invalidRequest(errorText("flow.changed"));
    return ok(await withRepositoryChange(id, () => services.writer.gitflow(id, action)));
  });

  handle(IPC_CHANNELS.repositoryWorktrees, async (_event, id) =>
    ok(await services.repositoryReader.worktrees(requireId(id))),
  );

  handle(IPC_CHANNELS.repositoryWorkingDiff, async (_e, raw) => {
    const input = requireRecord(raw, t("main.repositoryHandlers.workingDiffRequest"));

    const repository = repositories.resolveActiveRepository(
      requireId(input["repositoryId"], t("fields.repositoryId")),
    );

    const area = input["area"];

    if (area !== "staged" && area !== "unstaged")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseAValidDiffArea"));

    return ok(
      await git.workingDiff(repository.path, {
        area,
        ...diffDisplayOptions(input),
        ...(input["paths"] !== undefined && {
          paths: requireStringArray(input["paths"], t("fields.paths"), 256),
        }),
      }),
    );
  });

  handle(IPC_CHANNELS.repositoryCommitDiff, async (_e, raw) => {
    const input = requireRecord(raw, t("main.repositoryHandlers.commitDiffRequest"));

    const repository = repositories.resolveActiveRepository(
      requireId(input["repositoryId"], t("fields.repositoryId")),
    );

    return ok(
      await git.commitDiff(
        repository.path,
        requireString(input["oid"], t("fields.commitObjectId"), 64),
        input["paths"] === undefined
          ? undefined
          : requireStringArray(input["paths"], t("fields.paths"), 256),
        diffDisplayOptions(input),
      ),
    );
  });

  handle(IPC_CHANNELS.repositoryCompareRevisions, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.revisionComparison"),
    );
    const mode = input["mode"];
    if (mode !== "direct" && mode !== "merge-base")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseAComparisonMode"));

    return ok(
      await services.repositoryReader.compareRevisions({
        repositoryId,
        left: requireString(input["left"], t("fields.referenceName"), 255),
        right: requireString(input["right"], t("fields.referenceName"), 255),
        mode,
      }),
    );
  });

  handle(IPC_CHANNELS.repositoryBlame, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(raw, t("revision.blame"));
    return ok(
      await services.repositoryReader.blame({
        repositoryId,
        oid: requireString(input["oid"], t("fields.commitObjectId"), 64),
        path: requireString(input["path"], t("fields.filePath")),
        start: optionalInteger(input["start"], t("fields.historyOffset"), 1, 1_000_000) ?? 1,
      }),
    );
  });

  handle(IPC_CHANNELS.repositoryRevisionPath, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(raw, t("revision.browse"));
    return ok(
      await services.repositoryReader.revisionPath({
        repositoryId,
        oid: requireString(input["oid"], t("fields.commitObjectId"), 64),
        ...(input["path"] !== undefined && {
          path: requireString(input["path"], t("fields.filePath")),
        }),
      }),
    );
  });

  handle(IPC_CHANNELS.repositoryComparisonDiff, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.revisionComparison"),
    );
    return ok(
      await services.repositoryReader.comparisonDiff({
        ...diffDisplayOptions(input),
        repositoryId,
        baseOid: requireString(input["baseOid"], t("fields.commitObjectId"), 64),
        rightOid: requireString(input["rightOid"], t("fields.commitObjectId"), 64),
        path: requireString(input["path"], t("fields.filePath")),
        ...(input["oldPath"] !== undefined && {
          oldPath: requireString(input["oldPath"], t("fields.filePath")),
        }),
      }),
    );
  });

  const imageRequest = (raw: unknown) => {
    const input = requireRecord(raw, t("main.repositoryHandlers.imagePreviewRequest"));

    const repositoryId = requireId(input["repositoryId"], t("fields.repositoryId"));

    const kind = input["kind"];

    if (kind !== "working" && kind !== "staged" && kind !== "commit")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseAValidImageSource"));

    const request = {
      repositoryId,
      path: requireString(input["path"], t("fields.imagePath"), 4096),
      ...(input["oldPath"] !== undefined && {
        oldPath: requireString(input["oldPath"], t("fields.originalImagePath"), 4096),
      }),
    };

    const selected: ImagePreviewRequest =
      kind === "commit"
        ? { ...request, kind, oid: requireString(input["oid"], t("fields.commitObjectId"), 64) }
        : { ...request, kind };
    return selected;
  };

  handle(IPC_CHANNELS.repositoryExternalDiff, async (_event, raw) => {
    await services.externalTools.openDiff(imageRequest(raw));
    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryImagePreview, async (_event, raw) => {
    const selected = imageRequest(raw);
    const repository = repositories.resolveActiveRepository(selected.repositoryId);
    return ok(await readImagePreview(git, repository.path, selected));
  });

  handle(IPC_CHANNELS.repositoryChooseFolder, async (event) => {
    const profileId = services.identity.getActive()?.id;
    const root = profileId
      ? services.preferences.resolve("repositoryRoot", { profileId }).value
      : "";
    const result = await showOpenDialog(event, {
      ...(root ? { defaultPath: root } : {}),
      properties: ["openDirectory", "createDirectory"],
    });

    return ok(result.canceled ? null : (result.filePaths[0] ?? null));
  });

  const writer = services.writer;

  const parsePartial = (raw: unknown): PartialStageRequest => {
    const input = requireRecord(raw, t("main.repositoryHandlers.partialStaging"));
    const area = input["area"];

    if (area !== "staged" && area !== "unstaged")
      throw invalidRequest(errorText("main.repositoryHandlers.chooseStagedOrUnstagedChanges"));

    const index = (raw: unknown) => {
      const value = optionalInteger(raw, t("fields.selectionIndex"), 0, 100_000);
      if (value === undefined)
        throw invalidRequest(errorText("main.repositoryHandlers.missingSelectionIndex"));
      return value;
    };

    const array = (raw: unknown): unknown[] => {
      if (raw === undefined) return [];
      if (!Array.isArray(raw) || raw.length > 12_000)
        throw invalidRequest(errorText("main.repositoryHandlers.tooManySelectedLines"));
      return raw;
    };

    return {
      repositoryId: requireId(input["repositoryId"]),
      path: requireString(input["path"], t("fields.filePath")),
      area,
      hunks: array(input["hunks"]).map(index),
      lines: array(input["lines"]).map((raw) => {
        const line = requireRecord(raw, t("main.repositoryHandlers.lineSelection"));
        return { hunk: index(line["hunk"]), line: index(line["line"]) };
      }),
    };
  };

  handle(IPC_CHANNELS.repositoryPreviewPartial, async (_event, raw) =>
    ok(await writer.previewPartial(parsePartial(raw))),
  );

  handle(IPC_CHANNELS.repositoryPreviewDiscardPartial, async (_event, raw) =>
    ok(await writer.previewDiscardPartial(parsePartial(raw))),
  );

  handle(IPC_CHANNELS.repositoryApplyPartial, async (_event, rawId, rawToken) => {
    const id = requireId(rawId);
    await withRepositoryChange(id, async () => writer.applyPartial(id, requireId(rawToken)));

    return ok(undefined);
  });

  const optionalPaths = (raw: unknown) =>
    raw === undefined ? undefined : requireStringArray(raw, t("fields.paths"), 256);

  handle(IPC_CHANNELS.repositoryStage, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.stageRequest"),
    );

    await withRepositoryChange(repositoryId, async () =>
      writer.stage(repositoryId, optionalPaths(input["paths"])),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryUnstage, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.unstageRequest"),
    );

    await withRepositoryChange(repositoryId, async () =>
      writer.unstage(repositoryId, optionalPaths(input["paths"])),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryCommit, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.commitRequest"),
    );

    const message = requireString(input["message"], t("fields.commitMessage"), 100_000);
    const options = {
      amend: input["amend"] === true,
      signOff: input["signOff"] === true,
      ...(input["skipCommitHooks"] === true && { skipCommitHooks: true }),
    };
    const stagePaths = optionalPaths(input["stagePaths"]);

    const result = await withRepositoryChange(repositoryId, async () =>
      stagePaths === undefined
        ? await writer.commit(repositoryId, message, options)
        : await writer.stageAndCommit(repositoryId, stagePaths, message, options),
    );

    return ok(result);
  });

  handle(IPC_CHANNELS.repositoryListBranches, async (_e, rawId) =>
    ok(await writer.listBranches(requireId(rawId, t("fields.repositoryId")))),
  );

  handle(IPC_CHANNELS.repositoryCreateBranch, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.branchRequest"),
    );

    await withRepositoryChange(repositoryId, async () =>
      writer.createBranch(repositoryId, requireString(input["name"], t("fields.branchName"), 255), {
        checkout: input["checkout"] === true,
        ...(input["startPoint"] !== undefined && {
          startPoint: requireString(input["startPoint"], t("fields.startPoint"), 64),
        }),
      }),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryCheckoutBranch, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.branchRequest"),
    );

    await withRepositoryChange(repositoryId, async () =>
      writer.checkoutBranch(
        repositoryId,
        requireString(input["name"], t("fields.branchName"), 255),
      ),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryDeleteBranch, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.branchRequest"),
    );

    await withRepositoryChange(repositoryId, async () =>
      writer.deleteBranch(repositoryId, requireString(input["name"], t("fields.branchName"), 255), {
        force: input["force"] === true,
      }),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryRenameBranch, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.branchRequest"),
    );

    await withRepositoryChange(repositoryId, async () =>
      writer.renameBranch(
        repositoryId,
        requireString(input["from"], t("fields.branchName"), 255),
        requireString(input["to"], t("fields.branchName"), 255),
      ),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryVerifyTag, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(
      raw,
      t("main.repositoryHandlers.tagVerification"),
    );

    return ok(
      await writer.verifyTag(repositoryId, requireString(input["name"], t("fields.tagName"), 255)),
    );
  });

  handle(IPC_CHANNELS.repositoryListTags, async (_e, rawId) =>
    ok(await writer.listTags(requireId(rawId, t("fields.repositoryId")))),
  );

  handle(IPC_CHANNELS.repositoryCreateTag, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(raw, t("main.repositoryHandlers.tagRequest"));

    await withRepositoryChange(repositoryId, async () =>
      writer.createTag(repositoryId, requireString(input["name"], t("fields.tagName"), 255), {
        sign: input["sign"] === true,
        ...(input["message"] !== undefined && {
          message: requireString(input["message"], t("fields.tagMessage"), 100_000),
        }),
        ...(input["target"] !== undefined && {
          target: requireString(input["target"], t("fields.target"), 64),
        }),
      }),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryDeleteTag, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(raw, t("main.repositoryHandlers.tagRequest"));
    await withRepositoryChange(repositoryId, async () =>
      writer.deleteTag(repositoryId, requireString(input["name"], t("fields.tagName"), 255)),
    );

    return ok(undefined);
  });

  handle(IPC_CHANNELS.repositoryCheckoutTag, async (_e, raw) => {
    const { input, repositoryId } = repositoryRequest(raw, t("main.repositoryHandlers.tagRequest"));
    await withRepositoryChange(repositoryId, async () =>
      writer.checkoutTag(repositoryId, requireString(input["name"], t("fields.tagName"), 255)),
    );

    return ok(undefined);
  });
}
