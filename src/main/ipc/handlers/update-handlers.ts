import { errorText } from "@shared/error-codes";
import { ok } from "@shared/errors";
import { IPC_CHANNELS, IPC_EVENTS } from "@shared/ipc";
import { BrowserWindow } from "electron";
import type { Services } from "../../services";
import { invalidRequest } from "../../request-errors";
import { broadcast, handle } from "../transport";

export function registerUpdateHandlers(services: Services): void {
  const { updates } = services;
  updates.onChange((state) => broadcast(IPC_EVENTS.updateChanged, state));
  const caller = (event: Electron.IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
      throw invalidRequest(errorText("main.updateHandlers.updatesRequireTheApplicationWindow"));
  };
  handle(IPC_CHANNELS.updatesState, async (event) => {
    caller(event);
    return ok(updates.snapshot());
  });
  handle(IPC_CHANNELS.updatesCheck, async (event) => {
    caller(event);
    return ok(await updates.check());
  });
  handle(IPC_CHANNELS.updatesDownload, async (event) => {
    caller(event);
    return ok(await updates.download());
  });
  handle(IPC_CHANNELS.updatesInstall, async (event) => {
    caller(event);
    return ok(await updates.install());
  });
}
