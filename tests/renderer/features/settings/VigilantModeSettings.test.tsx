import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok } from "@shared/errors";
import {
  builtInSetting,
  type SettingKey,
  type SettingsContext,
  type SettingScope,
  type SettingValues,
} from "@shared/preferences/settings";
import { VigilantModeSettings } from "@renderer/features/settings/appearance/VigilantModeSettings";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { errorFixture } from "../../../helpers/error";

let root: Root;
let container: HTMLDivElement;
let previousApp: ReturnType<typeof useAppStore.getState>;
let previousPreferences: ReturnType<typeof usePreferencesStore.getState>;
let globalValue: boolean;
let profileValue: boolean | undefined;

const save = vi.fn(
  async (_key: SettingKey, scope: SettingScope, value: SettingValues[SettingKey]) => {
    if (typeof value !== "boolean") throw new Error("Expected a boolean preference");
    if (scope.kind === "application") globalValue = value;
    else profileValue = value;
    return ok(undefined);
  },
);
const reset = vi.fn(async () => {
  profileValue = undefined;
  return ok(undefined);
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previousApp = useAppStore.getState();
  previousPreferences = usePreferencesStore.getState();
  globalValue = false;
  profileValue = undefined;
  save.mockClear();
  reset.mockClear();
  vi.stubGlobal("eda", {
    settings: {
      resolve: async (key: SettingKey, context: SettingsContext = {}) => {
        if (key !== "vigilantMode") return ok(builtInSetting(key));
        const overridden = !!context.profileId && profileValue !== undefined;
        return ok({
          ...builtInSetting(key),
          value: overridden ? profileValue : globalValue,
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
      rules: [],
      createdAt: "now",
      updatedAt: "now",
    },
    switchingIdentityId: null,
  });
  usePreferencesStore.setState({
    context: { profileId: "work" },
    loading: false,
    saving: false,
    error: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(previousApp);
  usePreferencesStore.setState(previousPreferences);
  vi.unstubAllGlobals();
});

async function choose(label: string) {
  await act(async () =>
    container
      .querySelector<HTMLElement>('[role="combobox"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === label,
  )!;
  expect(option).toBeDefined();
  await act(async () => option.click());
}

it("edits the global default independently of an active profile override and retains it after a failed save", async () => {
  profileValue = true;
  await act(async () => root.render(<VigilantModeSettings />));
  const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(toggle.checked).toBe(false);
  expect(toggle.disabled).toBe(false);
  await act(async () => toggle.click());
  expect(save).toHaveBeenLastCalledWith("vigilantMode", { kind: "application" }, true);
  expect(toggle.checked).toBe(true);

  save.mockResolvedValueOnce(err(errorFixture({ message: "Save failed" })));
  await act(async () => toggle.click());
  expect(toggle.checked).toBe(true);
  expect(usePreferencesStore.getState().error?.message).toBe("Save failed");
});

it("lets a profile override either global value or return to following global", async () => {
  globalValue = true;
  await act(async () => root.render(<VigilantModeSettings owner="profile" />));
  const select = container.querySelector('[role="combobox"]')!;
  expect(select.textContent).toBe("Follow global");
  await choose("Off");
  expect(save).toHaveBeenLastCalledWith(
    "vigilantMode",
    { kind: "profile", profileId: "work" },
    false,
  );
  expect(select.textContent).toBe("Off");
  expect(usePreferencesStore.getState().values.vigilantMode.value).toBe(false);

  reset.mockResolvedValueOnce(err(errorFixture({ message: "Reset failed" })));
  await choose("Follow global");
  expect(select.textContent).toBe("Off");
  await choose("Follow global");
  expect(reset).toHaveBeenLastCalledWith("vigilantMode", { kind: "profile", profileId: "work" });
  expect(select.textContent).toBe("Follow global");
  expect(usePreferencesStore.getState().values.vigilantMode.value).toBe(true);

  globalValue = false;
  await choose("On");
  expect(select.textContent).toBe("On");
  expect(usePreferencesStore.getState().values.vigilantMode.value).toBe(true);
  await choose("Follow global");
  expect(usePreferencesStore.getState().values.vigilantMode.value).toBe(false);
});
