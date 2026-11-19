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
import { isMergeTool } from "@shared/integrations/merge-tool";
import { BrowserWindow, app, dialog } from "electron";
import { readBackgroundImage } from "../../application/background-image";
import { applyWindowZoom } from "../../application/window-zoom";
import type { Services } from "../../services";
import { broadcast, handle } from "../transport";

import { invalidRequest } from "../request-errors";
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

  handle(IPC_CHANNELS.settingsResolve, async (_e, rawKey, rawContext) =>
    ok(services.preferences.resolve(requireSettingKey(rawKey), context(rawContext))),
  );

  handle(IPC_CHANNELS.settingsSet, async (_e, rawKey, rawScope, value) => {
    const key = requireSettingKey(rawKey);
    const target = scope(rawScope);
    if (key === "editorExecutable" || key === "browserExecutable" || key === "mergeTool") {
      validateSetting(key, target, value);
      const command = isMergeTool(value) ? [value.executable, ...value.args] : [value];
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
    services.preferences.set(key, target, value);
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
