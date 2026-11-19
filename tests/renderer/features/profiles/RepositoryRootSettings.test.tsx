import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok } from "@shared/errors";
import type { Identity } from "@shared/identity/identity";
import {
  builtInSetting,
  type SettingKey,
  type SettingScope,
  type SettingsContext,
} from "@shared/preferences/settings";
import { RepositoryRootSettings } from "@renderer/features/profiles/RepositoryRootSettings";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { errorFixture } from "../../../helpers/error";

let root: Root;
let container: HTMLDivElement;
let previousApp: ReturnType<typeof useAppStore.getState>;
let previousPreferences: ReturnType<typeof usePreferencesStore.getState>;
let savedPaths: Record<string, string>;
const work: Identity = {
  id: "work",
  name: "Work",
  gitName: "Author",
  gitEmail: "work@example.com",
  hue: 210,
  signing: { format: "none", signCommits: false },
  createdAt: "now",
  updatedAt: "now",
};
const save = vi.fn();
const chooseFolder = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previousApp = useAppStore.getState();
  previousPreferences = usePreferencesStore.getState();
  useAppStore.setState({ activeIdentity: work, switchingIdentityId: null });
  usePreferencesStore.setState({ context: { profileId: "work" }, saving: false, error: null });
  savedPaths = { work: "/old-root", home: "/home-root" };
  save
    .mockReset()
    .mockImplementation(async (_key: SettingKey, scope: SettingScope, value: string) => {
      if (scope.kind === "profile") savedPaths[scope.profileId] = value;
      return ok(undefined);
    });
  chooseFolder.mockReset().mockResolvedValue(ok("/new-root"));
  vi.stubGlobal("eda", {
    repository: { chooseFolder },
    settings: {
      resolve: async (key: SettingKey, context: SettingsContext) =>
        ok(
          key === "repositoryRoot"
            ? { ...builtInSetting(key), value: savedPaths[context.profileId ?? ""] ?? "" }
            : builtInSetting(key),
        ),
      set: save,
    },
  });
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

const input = () => container.querySelector("input")!;
const browse = () => container.querySelector<HTMLButtonElement>("button")!;

it("shows the saved root and persists a browsed folder only for the active profile", async () => {
  await act(async () => root.render(<RepositoryRootSettings />));
  expect(input().value).toBe("/old-root");
  expect(input().readOnly).toBe(true);
  await act(async () => browse().click());
  expect(save).toHaveBeenLastCalledWith(
    "repositoryRoot",
    { kind: "profile", profileId: "work" },
    "/new-root",
  );
  expect(input().value).toBe("/new-root");
});

it("keeps the saved root when the folder picker is cancelled", async () => {
  chooseFolder.mockResolvedValueOnce(ok(null));
  await act(async () => root.render(<RepositoryRootSettings />));
  await act(async () => browse().click());
  expect(save).not.toHaveBeenCalled();
  expect(input().value).toBe("/old-root");
});

it("keeps the saved root when persistence fails and reports the failure", async () => {
  save.mockResolvedValueOnce(err(errorFixture({ kind: "unknown", message: "Disk full" })));
  await act(async () => root.render(<RepositoryRootSettings />));
  await act(async () => browse().click());
  expect(input().value).toBe("/old-root");
  expect(usePreferencesStore.getState().error?.message).toBe("Disk full");
});

it("reports a folder picker failure and allows trying again", async () => {
  chooseFolder.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => root.render(<RepositoryRootSettings />));
  await act(async () => browse().click());
  expect(document.body.textContent).toContain("Could not open the folder picker");
  expect(input().value).toBe("/old-root");
  expect(browse().disabled).toBe(false);
  await act(async () => browse().click());
  expect(input().value).toBe("/new-root");
});

it("loads the new profile’s root after switching profiles", async () => {
  await act(async () => root.render(<RepositoryRootSettings />));
  await act(async () => {
    useAppStore.setState({ activeIdentity: { ...work, id: "home", name: "Home" } });
    usePreferencesStore.setState({ context: { profileId: "home" } });
  });
  expect(input().value).toBe("/home-root");
  await act(async () => browse().click());
  expect(save).toHaveBeenLastCalledWith(
    "repositoryRoot",
    { kind: "profile", profileId: "home" },
    "/new-root",
  );
  expect(savedPaths["work"]).toBe("/old-root");
});

it("does not save a folder picked for a profile after switching away from it", async () => {
  let finish!: (result: ReturnType<typeof ok<string>>) => void;
  chooseFolder.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => root.render(<RepositoryRootSettings />));
  await act(async () => browse().click());
  await act(async () => {
    useAppStore.setState({ activeIdentity: { ...work, id: "home", name: "Home" } });
    usePreferencesStore.setState({ context: { profileId: "home" } });
  });
  await act(async () => finish(ok("/late-folder")));
  expect(save).not.toHaveBeenCalled();
  expect(input().value).toBe("/home-root");
});
