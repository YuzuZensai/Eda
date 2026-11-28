import { _electron, type ElectronApplication, type Page } from "playwright";

export const electron = {
  launch(options: Parameters<typeof _electron.launch>[0]) {
    return _electron.launch({
      ...options,
      args: [
        ...(options?.args ?? []),
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
      ],
    });
  },
};

export function pickOpenFile(app: ElectronApplication, filePath: string) {
  return app.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [path] };
    };
  }, filePath);
}

export function activeIdentity(page: Page) {
  return page.evaluate(async () => {
    const result = await window.eda.identity.getActive();
    if (!result.ok || !result.value)
      throw new Error("Expected an active identity: " + JSON.stringify(result));
    return result.value;
  });
}

export function firstRepository(page: Page) {
  return page.evaluate(async () => {
    const result = await window.eda.repository.list();
    if (!result.ok) throw new Error("Expected repositories: " + JSON.stringify(result));
    return result.value[0];
  });
}
