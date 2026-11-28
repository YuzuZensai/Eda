import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok } from "@shared/errors";
import { builtInSetting, type SettingKey } from "@shared/preferences/settings";
import { FetchSettings } from "@renderer/features/settings/git/FetchSettings";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { errorFixture } from "../../../helpers/error";

let root: Root;
let container: HTMLDivElement;
let allTags = false;
const save = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  allTags = false;
  useAppStore.setState({
    activeIdentity: { id: "profile" } as never,
    selectedRepositoryId: "repo",
    switchingIdentityId: null,
  });
  usePreferencesStore.setState({
    context: { profileId: "profile", repositoryId: "repo" },
    saving: false,
    error: null,
  });
  save.mockReset().mockImplementation(async (_key, _scope, value: boolean) => {
    allTags = value;
    return ok(undefined);
  });
  vi.stubGlobal("eda", {
    settings: {
      resolve: async (key: SettingKey) =>
        ok(key === "fetchTags" ? { ...builtInSetting(key), value: allTags } : builtInSetting(key)),
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
  vi.unstubAllGlobals();
});

const checkbox = () =>
  [...container.querySelectorAll("label")]
    .find((label) => label.textContent === "Fetch all tags")!
    .querySelector("input")!;

it("keeps automatic tag following as the default and saves the repository's all-tags choice", async () => {
  await act(async () => root.render(<FetchSettings repositoryId="repo" />));
  expect(checkbox().checked).toBe(false);
  expect(checkbox().disabled).toBe(false);
  expect(container.textContent).toContain("Fetch, Pull, and background fetch");

  await act(async () => checkbox().click());
  expect(save).toHaveBeenLastCalledWith(
    "fetchTags",
    { kind: "repository", profileId: "profile", repositoryId: "repo" },
    true,
  );
  expect(checkbox().checked).toBe(true);

  await act(async () => checkbox().click());
  expect(save).toHaveBeenLastCalledWith(
    "fetchTags",
    { kind: "repository", profileId: "profile", repositoryId: "repo" },
    false,
  );
  expect(checkbox().checked).toBe(false);
});

it("restores the saved tag choice if changing it fails", async () => {
  allTags = true;
  save.mockResolvedValueOnce(
    err(errorFixture({ kind: "unknown", message: "Could not save the preference" })),
  );
  await act(async () => root.render(<FetchSettings repositoryId="repo" />));
  expect(checkbox().checked).toBe(true);
  await act(async () => checkbox().click());
  expect(checkbox().checked).toBe(true);
});

it("reads the application fetch interval once when no repository override is displayed", async () => {
  const resolve = vi.spyOn(window.eda.settings, "resolve");
  await act(async () => root.render(<FetchSettings />));
  expect(resolve.mock.calls.filter(([key]) => key === "backgroundFetchMinutes")).toHaveLength(1);
});
