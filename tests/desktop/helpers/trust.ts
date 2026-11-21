import type { RepositoryTrustRequest } from "../../../src/shared/repository/repository";
import { realpath } from "node:fs/promises";
import type { ElectronApplication, Page } from "playwright";

export async function trustFixture(app: ElectronApplication, root: string) {
  const roots = [root, await realpath(root)];
  await app.evaluate(
    ({ dialog }, { roots, editor, windows }) => {
      const original = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = (
        first: Electron.BaseWindow | Electron.MessageBoxOptions,
        second?: Electron.MessageBoxOptions,
      ) => {
        const options = second ?? (first as Electron.MessageBoxOptions);
        const normalize = (path: string) => {
          const normalized = path.replaceAll("\\", "/");
          return windows ? normalized.toLowerCase() : normalized;
        };
        const detail = options.detail && normalize(options.detail);
        if (
          options.buttons?.includes("Allow program") &&
          detail &&
          (roots.some((root) => detail.includes(normalize(root) + "/")) ||
            roots.some((root) => options.detail?.includes(JSON.stringify(root).slice(1, -1))) ||
            options.detail === JSON.stringify([editor]))
        )
          return Promise.resolve({ response: 1, checkboxChecked: false });
        return second ? original(first as Electron.BaseWindow, second) : original(options);
      };
    },
    {
      roots,
      editor: process.execPath,
      windows: process.platform === "win32",
    },
  );
  await trustFixturePage(await app.firstWindow(), roots);
}

export async function trustFixturePage(page: Page, roots: string[]) {
  const approveFixtures = ({ roots, windows }: { roots: string[]; windows: boolean }) => {
    const normalize = (path: string) => {
      const normalized = path.replaceAll("\\", "/");
      return windows ? normalized.toLowerCase() : normalized;
    };
    const approve = (request: RepositoryTrustRequest | null) => {
      if (!request) return;
      const path = normalize(request.path);
      if (roots.some((root) => path.startsWith(normalize(root) + "/")))
        void window.eda.repository.respondTrust(request.id, true);
    };
    window.eda.events.onRepositoryTrustChanged(approve);
    void window.eda.repository.pendingTrust().then((result) => {
      if (result.ok) approve(result.value);
    });
  };
  const options = { roots, windows: process.platform === "win32" };
  await page.addInitScript(approveFixtures, options);
  await page.evaluate(approveFixtures, options);
}
