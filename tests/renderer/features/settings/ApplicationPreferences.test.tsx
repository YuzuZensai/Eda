import { chooseOption } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok } from "@shared/errors";
import {
  builtInSetting,
  type SettingKey,
  type SettingScope,
  type SettingsContext,
} from "@shared/preferences/settings";
import { ApplicationPreferences } from "@renderer/features/settings/application/ApplicationPreferences";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { deferred } from "../../../helpers/deferred";
import { errorFixture } from "../../../helpers/error";

vi.mock("@renderer/features/settings/git/MergeToolSettings", () => ({
  MergeToolSettings: () => null,
}));
vi.mock("@renderer/features/settings/application/GraphicsSettings", () => ({
  GraphicsSettings: () => null,
}));
vi.mock("@renderer/features/settings/application/LanguageSettings", () => ({
  LanguageSettings: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let previousApp: ReturnType<typeof useAppStore.getState>;
let previousPreferences: ReturnType<typeof usePreferencesStore.getState>;
let globalBrowser: string;
let profileBrowsers: Record<string, string>;
const chooseBrowser = vi.fn();
const save = vi.fn();
const reset = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previousApp = useAppStore.getState();
  previousPreferences = usePreferencesStore.getState();
  globalBrowser = "";
  profileBrowsers = {};
  chooseBrowser.mockReset().mockResolvedValue(ok("/tools/custom-browser"));
  save
    .mockReset()
    .mockImplementation(async (key: SettingKey, scope: SettingScope, value: unknown) => {
      if (key === "browserExecutable" && typeof value === "string") {
        if (scope.kind === "application") globalBrowser = value;
        else profileBrowsers[scope.profileId] = value;
      }
      return ok(undefined);
    });
  reset.mockReset().mockImplementation(async (_key: SettingKey, scope: SettingScope) => {
    if (scope.kind === "profile") delete profileBrowsers[scope.profileId];
    return ok(undefined);
  });
  vi.stubGlobal("eda", {
    app: {
      chooseBrowser,
      chooseEditor: vi.fn().mockResolvedValue(ok("/tools/editor")),
      detectEditors: vi
        .fn()
        .mockResolvedValue(ok([{ name: "Test editor", executable: "/tools/editor" }])),
    },
    settings: {
      resolve: async (key: SettingKey, context: SettingsContext = {}) => {
        if (key !== "browserExecutable") return ok(builtInSetting(key));
        const overridden = !!context.profileId && profileBrowsers[context.profileId] !== undefined;
        return ok({
          ...builtInSetting(key),
          value: overridden ? profileBrowsers[context.profileId!] : globalBrowser,
          source: overridden
            ? { kind: "profile", profileId: context.profileId }
            : { kind: "application" },
        });
      },
      set: save,
      reset,
    },
  });
  useAppStore.setState({
    activeIdentity: {
      id: "work",
      name: "Work",
      gitName: "Author",
      gitEmail: "work@example.test",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "now",
      updatedAt: "now",
    },
    switchingIdentityId: null,
  });
  usePreferencesStore.setState({ context: { profileId: "work" }, saving: false, error: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(previousApp, true);
  usePreferencesStore.setState(previousPreferences, true);
  vi.unstubAllGlobals();
});

const picker = (name: string) => {
  const label = Array.from(container.querySelectorAll("label")).find(
    (item) => item.textContent === name,
  );
  return document.getElementById(label!.htmlFor)!;
};
const browser = () => picker("Web browser");

it("defaults global browser selection to the OS and saves a custom application independently of profile overrides", async () => {
  profileBrowsers["work"] = "/tools/work-browser";
  await act(async () => root.render(<ApplicationPreferences />));
  expect(browser().textContent).toBe("OS default");
  await chooseOption(browser(), "Choose manually...");
  expect(save).toHaveBeenLastCalledWith(
    "browserExecutable",
    { kind: "application" },
    "/tools/custom-browser",
  );
  expect(browser().textContent).toBe("custom-browser");
  await chooseOption(browser(), "OS default");
  expect(save).toHaveBeenLastCalledWith("browserExecutable", { kind: "application" }, "");
  expect(profileBrowsers["work"]).toBe("/tools/work-browser");
});

it("allows profile-specific browsers, explicit OS defaults, and restoring global inheritance", async () => {
  globalBrowser = "/tools/global-browser";
  await act(async () => root.render(<ApplicationPreferences owner="profile" />));
  expect(browser().textContent).toBe("Follow global");
  expect(container.textContent).toContain("/tools/global-browser");
  await chooseOption(browser(), "Choose manually...");
  expect(save).toHaveBeenLastCalledWith(
    "browserExecutable",
    { kind: "profile", profileId: "work" },
    "/tools/custom-browser",
  );
  await chooseOption(browser(), "OS default");
  expect(save).toHaveBeenLastCalledWith(
    "browserExecutable",
    { kind: "profile", profileId: "work" },
    "",
  );
  expect(browser().textContent).toBe("OS default");
  await chooseOption(browser(), "Follow global");
  expect(reset).toHaveBeenLastCalledWith("browserExecutable", {
    kind: "profile",
    profileId: "work",
  });
  expect(browser().textContent).toBe("Follow global");
  expect(globalBrowser).toBe("/tools/global-browser");
});

it("retains the current choice after cancellation, failed selection, or failed persistence", async () => {
  globalBrowser = "/tools/global-browser";
  await act(async () => root.render(<ApplicationPreferences />));
  chooseBrowser.mockResolvedValueOnce(ok(null));
  await chooseOption(browser(), "Choose manually...");
  expect(save).not.toHaveBeenCalled();
  expect(browser().textContent).toBe("global-browser");
  chooseBrowser.mockRejectedValueOnce(new Error("Unavailable"));
  await chooseOption(browser(), "Choose manually...");
  expect(document.body.textContent).toContain("Could not select the application");
  const dismiss = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Dismiss",
  )!;
  await act(async () => dismiss.click());
  save.mockResolvedValueOnce(err(errorFixture({ message: "Save failed" })));
  await chooseOption(browser(), "OS default");
  expect(browser().textContent).toBe("global-browser");
  expect(usePreferencesStore.getState().error?.message).toBe("Save failed");
});

it("does not apply a browser chosen for a profile after switching profiles", async () => {
  let finish!: (value: ReturnType<typeof ok<string>>) => void;
  chooseBrowser.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => root.render(<ApplicationPreferences owner="profile" />));
  await chooseOption(browser(), "Choose manually...");
  await act(async () => {
    const work = useAppStore.getState().activeIdentity!;
    useAppStore.setState({ activeIdentity: { ...work, id: "home", name: "Home" } });
    usePreferencesStore.setState({ context: { profileId: "home" } });
  });
  await act(async () => finish(ok("/tools/late-browser")));
  expect(save).not.toHaveBeenCalled();
  expect(browser().textContent).toBe("Follow global");
});

it("keeps detected editor selection working without changing the browser", async () => {
  await act(async () => root.render(<ApplicationPreferences owner="profile" />));
  const editor = picker("External editor");
  await chooseOption(editor, "Test editor");
  expect(save).toHaveBeenLastCalledWith(
    "editorExecutable",
    { kind: "profile", profileId: "work" },
    "/tools/editor",
  );
  expect(browser().textContent).toBe("Follow global");
});

it("discards a browser choice made after its settings page closed and reopened", async () => {
  const selection = deferred<ReturnType<typeof ok<string>>>();
  chooseBrowser.mockReturnValueOnce(selection.promise);
  await act(async () => root.render(<ApplicationPreferences owner="profile" />));
  await chooseOption(browser(), "Choose manually...");
  await act(async () => root.render(null));
  await act(async () => root.render(<ApplicationPreferences owner="profile" />));
  await act(async () => selection.resolve(ok("/tools/late-browser")));

  expect(save).not.toHaveBeenCalled();
  expect(browser().textContent).toBe("Follow global");
});
