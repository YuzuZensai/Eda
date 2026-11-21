import { isTerminalOptions } from "@shared/repository/terminal";
import { randomUUID } from "node:crypto";
import {
  collectionManifest,
  importCollection,
  isCollection,
  isCollectionList,
  portableRemote,
} from "@shared/repository/collections";
import { showOpenDialog, showSaveDialog } from "../dialogs";
import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import {
  requireSettingKey,
  validateSetting,
  type SettingScope,
  type SettingsContext,
} from "@shared/preferences/settings";
import { isMergeTool, isDiffTool } from "@shared/integrations/merge-tool";
import { BrowserWindow, app, dialog } from "electron";
import { saveFile } from "../../filesystem/save-file";
import { readRegularFile } from "../../filesystem/read-regular-file";
import { readBackgroundImage } from "../../application/background-image";
import { applyWindowZoom } from "../../application/window-zoom";
import type { Services } from "../../services";
import { broadcast, handle } from "../transport";

import { invalidRequest } from "../../request-errors";
import { requireId, requireRecord } from "../validate";

export function registerSettingsHandlers(services: Services): void {
  const { identity } = services;
  const context = (raw: unknown): SettingsContext => {
    const input = requireRecord(raw, t("main.settingsHandlers.settingsContext"));
    const profileId =
      input["profileId"] === undefined
        ? undefined
        : requireId(input["profileId"], t("fields.profileId"));

    if (profileId && profileId !== identity.getActive()?.id)
      throw invalidRequest(
        errorText("main.settingsHandlers.theActiveProfileChangedRefreshPreferencesAndTryAgain"),
      );

    const repositoryId =
      input["repositoryId"] === undefined
        ? undefined
        : requireId(input["repositoryId"], t("fields.repositoryId"));

    return { ...(profileId ? { profileId } : {}), ...(repositoryId ? { repositoryId } : {}) };
  };

  const scope = (raw: unknown): SettingScope => {
    const input = requireRecord(raw, t("main.settingsHandlers.settingScope"));

    if (input["kind"] === "application") return { kind: "application" };

    const owner = context(input);

    if (!owner.profileId)
      throw invalidRequest(errorText("main.settingsHandlers.aProfileIsRequiredForThisScope"));
    if (input["kind"] === "profile") return { kind: "profile", profileId: owner.profileId };
    if (input["kind"] === "repository" && owner.repositoryId)
      return { kind: "repository", profileId: owner.profileId, repositoryId: owner.repositoryId };

    throw invalidRequest(errorText("main.settingsHandlers.unknownSettingScope"));
  };

  const previewing = new Map<Electron.WebContents, () => void>();
  const applyZoomTo = (contents: Electron.WebContents) => {
    if (contents.isDestroyed()) return;

    const active = identity.getActive();
    const value = services.preferences.resolve(
      "uiZoom",
      !previewing.has(contents) && active ? { profileId: active.id } : {},
    ).value;

    applyWindowZoom(contents, value / 100);

    const transparency = services.preferences.resolve(
      "windowTransparency",
      !previewing.has(contents) && active ? { profileId: active.id } : {},
    ).value;

    if (process.platform !== "linux")
      BrowserWindow.fromWebContents(contents)?.setOpacity(
        transparency.enabled ? transparency.opacity / 100 : 1,
      );
  };

  const applyZoom = () => {
    for (const window of BrowserWindow.getAllWindows()) applyZoomTo(window.webContents);
  };

  handle(IPC_CHANNELS.settingsPreviewGlobalAppearance, async (event, enabled) => {
    if (typeof enabled !== "boolean")
      throw invalidRequest(errorText("main.settingsHandlers.previewStateMustBeABoolean"));

    const contents = event.sender;

    if (enabled && !previewing.has(contents)) {
      const clear = () => {
        previewing.delete(contents);
        contents.removeListener("destroyed", clear);
        contents.removeListener("render-process-gone", clear);
        contents.removeListener("did-start-navigation", clear);
        applyZoomTo(contents);
      };

      previewing.set(contents, clear);
      contents.once("destroyed", clear);
      contents.once("render-process-gone", clear);
      contents.once("did-start-navigation", clear);
    } else if (!enabled) previewing.get(contents)?.();

    applyZoomTo(contents);

    return ok(undefined);
  });

  identity.onChange(applyZoom);
  app.on("browser-window-created", (_event, window) => {
    window.once("ready-to-show", () => applyZoomTo(window.webContents));
  });

  handle(IPC_CHANNELS.settingsChooseBackgroundImage, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);

    if (!parent)
      throw invalidRequest(errorText("main.settingsHandlers.theSettingsWindowIsUnavailable"));

    const result = await dialog.showOpenDialog(parent, {
      properties: ["openFile"],
      filters: [
        {
          name: t("main.fileFilters.backgroundImages"),
          extensions: ["png", "jpg", "jpeg", "webp"],
        },
      ],
    });

    if (result.canceled || !result.filePaths[0]) return ok(null);

    return ok(await readBackgroundImage(result.filePaths[0]));
  });

  const changed = (key: ReturnType<typeof requireSettingKey>, target: SettingScope) => {
    if (key === "automaticUpdateChecks" || key === "includePrereleaseUpdates")
      services.updates.refreshSchedule();
    if (key === "uiZoom" || key === "windowTransparency") applyZoom();
    broadcast(IPC_EVENTS.settingChanged, { key, scope: target });
  };

  handle(IPC_CHANNELS.settingsSaveCollections, async (_e, rawId, previous, next) => {
    const profileId = requireId(rawId);
    context({ profileId });
    if (!isCollectionList(previous) || !isCollectionList(next))
      throw invalidRequest(errorText("collections.invalid"));
    const current = services.preferences.resolve("localCollections", { profileId }).value;
    if (JSON.stringify(previous) !== JSON.stringify(current))
      throw invalidRequest(errorText("collections.conflict"));
    services.preferences.set("localCollections", { kind: "profile", profileId }, next);
    return ok(undefined);
  });
  handle(IPC_CHANNELS.settingsCollectionManifest, async (event, rawId, collection, paths) => {
    const profileId = requireId(rawId);
    context({ profileId });
    if (collection === undefined) {
      const chosen = await showOpenDialog(event, {
        title: t("collections.import"),
        properties: ["openFile"],
        filters: [{ name: t("collections.title"), extensions: ["json"] }],
      });
      if (chosen.canceled || !chosen.filePaths[0]) return ok(null);
      const { bytes } = await readRegularFile(chosen.filePaths[0], 1024 * 1024, () =>
        invalidRequest(errorText("collections.invalid")),
      );
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw invalidRequest(errorText("collections.invalid"));
      }
      const imported = importCollection(value, randomUUID());
      context({ profileId });
      if (!imported) throw invalidRequest(errorText("collections.invalid"));
      return ok(imported);
    }
    if (!isCollection(collection) || typeof paths !== "boolean")
      throw invalidRequest(errorText("collections.invalid"));
    const members = [];
    for (const member of collection.members) {
      if (!member.repositoryId) {
        members.push(member);
        continue;
      }
      const repo = services.repositories.resolveActiveRepository(member.repositoryId);
      const remote = await services.remotes.primaryFetchUrl(repo.id, { refresh: true });
      members.push({
        name: member.name,
        ...(portableRemote(remote) && { remote }),
        pathHint: repo.path,
      });
    }
    const options = {
      title: t("collections.export"),
      defaultPath: "collection.json",
      filters: [{ name: t("collections.title"), extensions: ["json"] }],
    };
    const chosen = await showSaveDialog(event, options);
    context({ profileId });
    if (!chosen.canceled && chosen.filePath)
      await saveFile(
        chosen.filePath,
        Buffer.from(
          JSON.stringify(collectionManifest({ ...collection, members }, paths), null, 2) + "\n",
        ),
      );
    return ok(null);
  });
  handle(IPC_CHANNELS.settingsTransferPreferences, async (event, rawScope, action) => {
    const target = scope(rawScope);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const filters = [{ name: t("settings.portable.title"), extensions: ["json"] }];
    if (!parent)
      throw invalidRequest(errorText("main.settingsHandlers.theSettingsWindowIsUnavailable"));
    if (action === "export") {
      const result = await dialog.showSaveDialog(parent, {
        title: t("settings.portable.export"),
        defaultPath: `eda-${target.kind}-preferences.json`,
        filters,
      });
      if (result.canceled || !result.filePath) return ok(false);
      const data = services.preferences.exportPortable(scope(rawScope));
      const bytes = Buffer.from(JSON.stringify(data, null, 2) + "\n");
      if (bytes.length > 256 * 1024) throw invalidRequest(errorText("settings.portable.tooLarge"));
      await saveFile(result.filePath, bytes);
    } else if (action === "import") {
      const result = await dialog.showOpenDialog(parent, {
        title: t("settings.portable.import"),
        properties: ["openFile"],
        filters,
      });
      if (result.canceled || !result.filePaths[0]) return ok(false);
      const { bytes } = await readRegularFile(result.filePaths[0], 256 * 1024, () =>
        invalidRequest(errorText("settings.portable.invalid")),
      );
      let file: unknown;
      try {
        file = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw invalidRequest(errorText("settings.portable.invalid"));
      }
      for (const key of services.preferences.importPortable(scope(rawScope), file))
        changed(key, target);
    } else throw invalidRequest(errorText("settings.portable.invalid"));
    return ok(true);
  });

  handle(IPC_CHANNELS.settingsResolve, async (_e, rawKey, rawContext) =>
    ok(services.preferences.resolve(requireSettingKey(rawKey), context(rawContext))),
  );

  handle(IPC_CHANNELS.settingsSet, async (_e, rawKey, rawScope, value) => {
    const key = requireSettingKey(rawKey);
    const target = scope(rawScope);
    if (
      key === "gitExecutable" ||
      key === "sshExecutable" ||
      key === "gpgExecutable" ||
      key === "diffTool" ||
      key === "diffExecutable" ||
      key === "terminalExecutable" ||
      (key === "terminalOptions" &&
        isTerminalOptions(value) &&
        target.kind === "profile" &&
        value.shell !==
          services.preferences.resolve(key, { profileId: target.profileId }).value.shell) ||
      key === "editorExecutable" ||
      key === "browserExecutable" ||
      key === "mergeTool"
    ) {
      validateSetting(key, target, value);
      const command =
        isMergeTool(value) || isDiffTool(value)
          ? [value.executable, ...value.args]
          : isTerminalOptions(value)
            ? [value.shell]
            : [value];
      if (command[0]) {
        const parent = BrowserWindow.fromWebContents(_e.sender);
        if (
          !parent ||
          (
            await dialog.showMessageBox(parent, {
              type: "warning",
              message: t("main.settingsHandlers.confirmProgram"),
              detail: JSON.stringify(command),
              buttons: [t("common.cancel"), t("main.settingsHandlers.allowProgram")],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
          ).response !== 1
        )
          throw invalidRequest(errorText("main.settingsHandlers.programDeclined"));
      }
    }
    services.preferences.set(key, scope(rawScope), value);
    changed(key, target);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.settingsReset, async (_e, rawKey, rawScope) => {
    const key = requireSettingKey(rawKey);
    const target = scope(rawScope);
    services.preferences.reset(key, target);
    changed(key, target);
    return ok(undefined);
  });
}
