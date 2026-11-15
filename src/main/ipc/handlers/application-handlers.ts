import { ERROR_CODE, errorText } from "@shared/error-codes";
import { AppError, ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import { app, BrowserWindow, clipboard, dialog } from "electron";
import { detectEditors } from "../../application/detect-editors";
import { detectMergeTools } from "../../application/detect-merge-tools";
import { graphicsStatus } from "../../application/graphics";
import { applyWindowZoom } from "../../application/window-zoom";
import { buildGitEnvironment } from "../../git/execution/environment";
import { NodeProcessRunner } from "../../git/execution/node-process-runner";
import type { Services } from "../../services";
import { showOpenDialog } from "../dialogs";
import { invalidRequest } from "../request-errors";
import { broadcast, exclusivelyReset, handle } from "../transport";
import { requireId, requireString } from "../validate";

export function registerApplicationHandlers(services: Services): void {
  handle(IPC_CHANNELS.appCopyText, async (_event, value) => {
    clipboard.writeText(requireString(value, t("fields.clipboardText"), 1_048_576));
    return ok(undefined);
  });
  handle(IPC_CHANNELS.avatarGet, async (_event, email) => {
    if (typeof email !== "string" || email.length > 320)
      throw invalidRequest(errorText("main.applicationHandlers.invalidAvatarEmail"));
    return ok(await services.avatars.get(email));
  });
  handle(IPC_CHANNELS.avatarCommitGet, async (_event, rawId, email) => {
    const repositoryId = requireId(rawId);
    if (typeof email !== "string" || email.length > 320)
      throw invalidRequest(errorText("main.applicationHandlers.invalidAvatarEmail"));
    const repository = services.repositories.resolveActiveRepository(repositoryId);
    const gitlabInstances = services.gitlabSelfHosted
      .status(repository.identityId)
      .accounts.map((account) => account.baseUrl);
    return ok(
      await services.avatars.getCommit(
        email,
        await services.remotes.primaryFetchUrl(repositoryId).catch(() => undefined),
        gitlabInstances,
      ),
    );
  });

  handle(IPC_CHANNELS.appGraphicsStatus, async () => ok(graphicsStatus()));
  handle(IPC_CHANNELS.appInstallation, async () => ok(services.installation));

  handle(IPC_CHANNELS.appDebug, async (event, action) => {
    if (
      action !== "open-dev-tools" &&
      action !== "ipc-error" &&
      action !== "renderer-crash" &&
      action !== "reset-data" &&
      action !== "import-release-data"
    )
      throw invalidRequest(errorText("main.applicationHandlers.unknownDebugAction"));

    const window = BrowserWindow.fromWebContents(event.sender);

    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
      throw invalidRequest(
        errorText("main.applicationHandlers.debugActionsRequireTheApplicationWindow"),
      );
    if (action === "ipc-error") throw new AppError(ERROR_CODE.DEBUG_IPC_FAILURE);
    if (action === "open-dev-tools") event.sender.openDevTools({ mode: "detach" });

    if (action === "import-release-data") {
      if (app.isPackaged) throw invalidRequest(errorText("main.appData.developmentOnly"));
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        title: t("main.appData.importTitle"),
        message: t("main.appData.importMessage"),
        detail: t("main.appData.importDetail"),
        buttons: [t("common.cancel"), t("main.appData.importAction")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (
        response === 1 &&
        !window.isDestroyed() &&
        !event.sender.isDestroyed() &&
        event.senderFrame === event.sender.mainFrame
      )
        await services.importReleaseData();
    }

    if (action === "reset-data") {
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        title: t("main.applicationHandlers.resetAllEdaData"),
        message: t("main.applicationHandlers.deleteAllEdaAppDataAndReturnToOnboarding"),
        detail: t("main.applicationHandlers.profilesSettingsSavedCredentialsAndDraftsWillBe"),
        buttons: [t("common.cancel"), t("main.applicationHandlers.resetAllData")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1 && !window.isDestroyed() && !event.sender.isDestroyed()) {
        await exclusivelyReset(async () => {
          await services.resetData();
          await event.sender.session.clearStorageData();
          await event.sender.session.clearCache();
          services.navigation.take();
          applyWindowZoom(event.sender, 1);
          if (process.platform !== "linux") window.setOpacity(1);
          event.sender.reload();
        });
      }
    }

    if (action === "renderer-crash") {
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        title: t("main.applicationHandlers.crashRenderer"),
        message: t("main.applicationHandlers.thisWillCrashEdaSCurrentWindow"),
        detail: t("main.applicationHandlers.unsavedInputMayBeLostRunningGitOperations"),
        buttons: [t("common.cancel"), t("main.applicationHandlers.crashRendererAction")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });

      if (
        response === 1 &&
        !window.isDestroyed() &&
        !event.sender.isDestroyed() &&
        event.senderFrame === event.sender.mainFrame
      )
        event.sender.forcefullyCrashRenderer();
    }

    return ok(undefined);
  });

  handle(IPC_CHANNELS.appDetectMergeTools, async () => ok(await detectMergeTools()));

  handle(IPC_CHANNELS.appChooseMergeTool, async (event) => {
    const result = await showOpenDialog(event, {
      title: t("main.applicationHandlers.chooseMergeToolExecutable"),
      properties: ["openFile"],
      ...(process.platform === "win32"
        ? { filters: [{ name: t("main.fileFilters.application"), extensions: ["exe"] }] }
        : {}),
    });

    return ok(result.canceled ? null : (result.filePaths[0] ?? null));
  });

  handle(IPC_CHANNELS.appDetectEditors, async () => ok(await detectEditors()));

  handle(IPC_CHANNELS.appChooseEditor, async (event) => {
    const result = await showOpenDialog(event, {
      title: t("main.applicationHandlers.chooseEditorExecutable"),
      properties: ["openFile"],
      ...(process.platform === "win32"
        ? { filters: [{ name: t("main.fileFilters.application"), extensions: ["exe"] }] }
        : {}),
    });

    return ok(result.canceled ? null : (result.filePaths[0] ?? null));
  });

  handle(IPC_CHANNELS.repositoryOpenEditor, async (_event, rawId) => {
    const repository = services.repositories.resolveActiveRepository(requireId(rawId));
    const editor = services.preferences.resolve("editorExecutable", {
      profileId: repository.identityId,
    }).value;

    if (!editor)
      throw invalidRequest(
        errorText("main.applicationHandlers.chooseAnEditorExecutableInApplicationSettingsFirst"),
      );

    try {
      await new NodeProcessRunner().launch(
        editor,
        [repository.path],
        repository.path,
        buildGitEnvironment(),
      );
    } catch {
      throw invalidRequest(
        errorText("main.applicationHandlers.theConfiguredEditorCouldNotStartChooseIts"),
      );
    }

    return ok(undefined);
  });

  services.navigation.onChange(() => broadcast(IPC_EVENTS.navigation));

  handle(IPC_CHANNELS.appTakeNavigation, async () => ok(services.navigation.take()));

  handle(IPC_CHANNELS.appWindowControl, async (event, action) => {
    if (
      typeof action !== "string" ||
      !["state", "minimize", "toggle-maximize", "close"].includes(action)
    )
      throw invalidRequest(errorText("main.applicationHandlers.unknownWindowAction"));

    const window = BrowserWindow.fromWebContents(event.sender);

    if (!window || window.isDestroyed())
      throw invalidRequest(errorText("main.applicationHandlers.theWindowIsNoLongerAvailable"));
    if (action === "minimize") window.minimize();

    if (action === "toggle-maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }

    const maximized = window.isMaximized();

    if (action === "close") window.close();

    return ok({ maximized });
  });

  const { git, engine } = services;

  handle(IPC_CHANNELS.appGetGitEngine, async () =>
    ok({ source: engine.source, path: engine.path, version: engine.version }),
  );

  handle(IPC_CHANNELS.appGetGlobalGitUser, async () => {
    const [name, email] = await Promise.all([
      git.readConfig("user.name", { scope: "global" }),
      git.readConfig("user.email", { scope: "global" }),
    ]);
    return ok({ ...(name ? { name } : {}), ...(email ? { email } : {}) });
  });
}
