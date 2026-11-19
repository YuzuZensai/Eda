import { DEVELOPMENT_DESKTOP, DEVELOPMENT_RESTART } from "@shared/application";
import { errorText } from "@shared/error-codes";
import { redactDiagnostic } from "@shared/diagnostics";
import { errorMessage, GitError } from "@shared/errors";
import { setLocale, t } from "@shared/i18n";
import { app, BrowserWindow, dialog, Menu, session } from "electron";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreShellPath } from "./git/execution/shell-path";
import { isRendererDocument, isRendererFile, rendererUrl } from "./application/renderer-url";
import { configureGraphics } from "./application/graphics";
import { recoverMigrationStartup } from "./application/startup-recovery";
import { registerWindowRecovery } from "./application/window-recovery";
import { applyWindowZoom } from "./application/window-zoom";
import { registerApplicationContents } from "./ipc/transport";
import { registerIpcHandlers } from "./ipc/register";
import {
  navigationFromArguments,
  parseRepositoryLink,
  type RepositoryNavigationQueue,
} from "./repo/lifecycle/navigation";
import { applyReleaseDataImport } from "./persistence/import-release-data";
import { createServices, type Services } from "./services";
import { migrateMacosKeychain } from "./secrets/migrate-macos-keychain";

if (app.isPackaged) {
  const { VelopackApp } = await import("velopack");
  VelopackApp.build().setAutoApplyOnStartup(false).run();
}

let navigation: RepositoryNavigationQueue | undefined;
const pendingLinks: string[] = [];

app.on("open-url", (event, url) => {
  event.preventDefault();
  const target = parseRepositoryLink(url);
  if (!target) return;
  if (navigation) navigation.push([target]);
  else if (pendingLinks.length < 20) pendingLinks.push(url);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const appIcon = app.isPackaged
  ? join(process.resourcesPath, "icon.png")
  : join(__dirname, "../../build/icon.png");

if (!app.commandLine.hasSwitch("user-data-dir")) {
  const name = isDev && process.env["VITE_DEV_SERVER_URL"] ? "Eda-Dev" : "Eda";
  const userData = join(app.getPath("appData"), name);
  const legacyData = join(app.getPath("appData"), name.toLowerCase());

  if (existsSync(legacyData)) {
    const names = readdirSync(app.getPath("appData"));
    if (!names.includes(name) && names.includes(name.toLowerCase()))
      renameSync(legacyData, userData);
  }

  mkdirSync(userData, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(userData, 0o700);
  app.setPath("userData", userData);
}

const liveDevelopment = isDev && !!process.env["VITE_DEV_SERVER_URL"];
app.setName(liveDevelopment ? DEVELOPMENT_DESKTOP.name : "Eda");
if (liveDevelopment && process.platform === "linux") app.setDesktopName(DEVELOPMENT_DESKTOP.file);
if (process.platform === "win32")
  app.setAppUserModelId(liveDevelopment ? DEVELOPMENT_DESKTOP.id : "cafe.kirameki.eda");

const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'" + (isDev ? " 'unsafe-inline'" : ""),
  "img-src 'self' data: https://www.gravatar.com",
  "font-src 'self' data:",
  "connect-src 'self'" + (isDev ? " ws://localhost:*" : ""),
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function createWindow(services: Services, zoom = 100): BrowserWindow {
  const window = new BrowserWindow({
    icon: appIcon,
    title: app.getName(),
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, titleBarOverlay: true }
      : { frame: false }),
    backgroundColor: "#0E1014",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
    },
  });

  registerApplicationContents(window.webContents);
  window.once("ready-to-show", () => window.show());
  registerWindowRecovery(window);

  if (isDev)
    window.webContents.on("console-message", (event) => {
      if (event.message.startsWith("[Eda navigation] ")) console.info(event.message);
    });

  applyWindowZoom(window.webContents, zoom / 100);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url))
      void services.browser.open(url, services.identity.getActive()?.id).catch((error: unknown) => {
        dialog.showErrorBox(t("common.openInBrowser"), errorMessage(error));
      });
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isRendererDocument(url)) event.preventDefault();
  });

  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );

  window.webContents.on("will-redirect", (event) => {
    if (event.isMainFrame && !isRendererDocument(event.url)) event.preventDefault();
  });

  void window.loadURL(rendererUrl());

  return window;
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, cwd) => {
    navigation?.push(navigationFromArguments(argv.slice(app.isPackaged ? 1 : 2), cwd));
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  void start();
}

async function start(): Promise<void> {
  try {
    const importIndex = process.argv.indexOf(DEVELOPMENT_RESTART.argument);
    if (importIndex !== -1) {
      process.argv.splice(importIndex, 1);
      if (app.isPackaged || !process.env["VITE_DEV_SERVER_URL"])
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.importReleaseData"),
          message: errorText("main.appData.developmentOnly"),
        });
      applyReleaseDataImport(app.getPath("userData"));
    }
    configureGraphics();
    await app.whenReady();
    if (isDev && process.platform === "darwin") app.dock?.setIcon(appIcon);
    setLocale(app.getPreferredSystemLanguages());
    if (importIndex !== -1) {
      await session.defaultSession.clearStorageData();
      await session.defaultSession.clearCache();
    }
    await migrateMacosKeychain();

    if (process.platform !== "darwin") Menu.setApplicationMenu(null);

    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["file://*/*"] },
      (details, callback) => callback({ cancel: !isRendererFile(details.url) }),
    );

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            details.resourceType === "subFrame" &&
            details.url === new URL("index.html?eda-tour=1", rendererUrl()).href
              ? CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
              : CSP,
          ],
        },
      });
    });

    await restoreShellPath();
    const services = await createServices();

    navigation = services.navigation;

    navigation.push([
      ...navigationFromArguments(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd()),
      ...pendingLinks.flatMap((link) => {
        const target = parseRepositoryLink(link);
        return target ? [target] : [];
      }),
    ]);

    if (app.isPackaged) app.setAsDefaultProtocolClient("eda");

    registerIpcHandlers(services);
    services.backgroundFetch.start();
    services.updates.start();

    let backgroundStopped = false;
    let stopping: Promise<void> | undefined;

    app.on("before-quit", (event) => {
      if (services.updates.blocksQuit) {
        event.preventDefault();
        return;
      }

      services.updates.stop();
      services.cancelSignIns();
      if (backgroundStopped) return;
      event.preventDefault();

      stopping ??= services.backgroundFetch
        .stop()
        .finally(() => services.sshAgent.stop())
        .finally(() => {
          backgroundStopped = true;
          app.quit();
        })
        .catch((error: unknown) => console.error("[Eda Shutdown]", error));
    });

    app.once("will-quit", () => services.db.close());

    createWindow(
      services,
      services.preferences.resolve(
        "uiZoom",
        services.identity.getActive() ? { profileId: services.identity.getActive()!.id } : {},
      ).value,
    );

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0)
        createWindow(
          services,
          services.preferences.resolve(
            "uiZoom",
            services.identity.getActive() ? { profileId: services.identity.getActive()!.id } : {},
          ).value,
        );
    });
  } catch (error) {
    const message = redactDiagnostic(error instanceof Error ? error.message : String(error));
    console.error("Eda could not start:", message);
    if (await recoverMigrationStartup(error)) return;
    const action = error instanceof GitError ? error.suggestedAction : undefined;

    dialog.showErrorBox(
      t("main.index.edaCouldNotStart"),
      [errorMessage(error), action].filter(Boolean).join("\n\n"),
    );

    app.exit(1);
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});
