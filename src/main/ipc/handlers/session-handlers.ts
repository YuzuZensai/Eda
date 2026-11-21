import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import type { SessionContext } from "@shared/identity/profile-session";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { Services } from "../../services";
import { invalidRequest } from "../../request-errors";
import { handle } from "../transport";
import { optionalInteger, requireId, requireRecord, requireString } from "../validate";

export function registerSessionHandlers(services: Services): void {
  const { identity } = services;
  const closing = new Map<number, string>();
  const readyToClose = new Set<number>();
  let quitting = false;

  app.on("before-quit", () => {
    if (!services.updates.blocksQuit) quitting = true;
  });

  app.on("browser-window-created", (_event, window) => {
    const caller = window.webContents.id;

    window.on("close", (event) => {
      if (services.updates.blocksQuit) {
        event.preventDefault();
        return;
      }

      if (
        readyToClose.has(caller) ||
        !services.sessions.hasBinding(caller) ||
        window.webContents.isDestroyed() ||
        window.webContents.isCrashed()
      )
        return;

      event.preventDefault();

      const nonce = closing.get(caller) ?? randomUUID();

      closing.set(caller, nonce);
      window.webContents.send(IPC_EVENTS.flushRequested, nonce);
    });
    window.once("closed", () => {
      closing.delete(caller);
      readyToClose.delete(caller);
      services.sessions.close(caller);
    });
  });

  handle(IPC_CHANNELS.sessionsReadyToClose, async (event, rawNonce) => {
    if (
      closing.get(event.sender.id) !==
      requireString(rawNonce, t("fields.closeAcknowledgement"), 128)
    )
      throw invalidRequest(errorText("main.sessionHandlers.invalidCloseAcknowledgement"));

    await identity.serialize(async () => undefined);
    closing.delete(event.sender.id);
    readyToClose.add(event.sender.id);

    // Preventing a window close cancels app.quit(), so resume it after the save handshake.
    if (quitting) app.quit();
    else BrowserWindow.fromWebContents(event.sender)?.close();

    return ok(undefined);
  });

  handle(IPC_CHANNELS.sessionsOpen, async (event) => ok(services.sessions.open(event.sender.id)));

  const sessionContext = (raw: unknown): SessionContext => {
    const input = requireRecord(raw, t("main.sessionHandlers.sessionContext"));
    const generation = optionalInteger(
      input["generation"],
      t("fields.sessionGeneration"),
      1,
      Number.MAX_SAFE_INTEGER,
    );

    if (generation === undefined)
      throw invalidRequest(errorText("main.sessionHandlers.missingSessionGeneration"));

    return {
      profileId: requireId(input["profileId"]),
      windowId: requireString(input["windowId"], t("fields.windowId"), 128),
      generation,
    };
  };

  handle(IPC_CHANNELS.sessionsChange, async (event, rawContext, rawChange) => {
    services.sessions.change(event.sender.id, sessionContext(rawContext), rawChange);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.sessionsReset, async (event, rawContext) =>
    ok(services.sessions.reset(event.sender.id, sessionContext(rawContext))),
  );
}
