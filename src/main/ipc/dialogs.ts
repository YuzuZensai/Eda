import { BrowserWindow, dialog } from "electron";

export async function showOpenDialog(
  event: Electron.IpcMainInvokeEvent,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
}

export function showSaveDialog(
  event: Electron.IpcMainInvokeEvent,
  options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
}
