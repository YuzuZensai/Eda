import { chooseOption } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GlobalGitWarning } from "@renderer/features/profiles/GlobalGitWarning";
import { StateSimulations } from "@renderer/features/settings/debug/StateSimulations";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { useSimulationStore } from "@renderer/stores/simulation-store";
import { profileGitConfig, type Identity } from "@shared/identity/identity";
import { builtInSetting, type SettingKey } from "@shared/preferences/settings";

const profile: Identity = {
  id: "work",
  name: "Work",
  gitName: "Work Author",
  gitEmail: "work@example.com",
  hue: 210,
  signing: { format: "none", signCommits: false },
  createdAt: "now",
  updatedAt: "now",
};
const previousApp = useAppStore.getState();
const previousPreferences = usePreferencesStore.getState();
let container: HTMLDivElement;
let root: Root;
let inspect: ReturnType<typeof vi.fn>;
let apply: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  inspect = vi.fn(async () => ({
    ok: true,
    value: {
      profileId: profile.id,
      global: Object.entries(profileGitConfig(profile)).map(([key, value]) => ({ key, value })),
    },
  }));
  apply = vi.fn();
  vi.stubGlobal("eda", {
    identity: { inspectGit: inspect, reapplyGlobal: apply },
    settings: {
      resolve: async (key: SettingKey) => ({
        ok: true,
        value:
          key === "developerSettingsEnabled"
            ? { ...builtInSetting(key), value: true }
            : builtInSetting(key),
      }),
    },
  });
  useAppStore.setState({ activeIdentity: profile, switchingIdentityId: null });
  usePreferencesStore.setState({
    context: { profileId: profile.id },
    values: {
      ...previousPreferences.values,
      developerSettingsEnabled: { ...builtInSetting("developerSettingsEnabled"), value: true },
      syncGlobalGitConfig: { ...builtInSetting("syncGlobalGitConfig"), value: false },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());

  container.remove();
  useSimulationStore.getState().reset();
  useAppStore.setState(previousApp);
  usePreferencesStore.setState(previousPreferences);
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  )!;

  expect(button).toBeDefined();

  await act(async () => button.click());
}

async function renderSettings() {
  await act(async () =>
    root.render(
      <>
        <GlobalGitWarning onReview={() => {}} />

        <main>
          <StateSimulations />
        </main>
      </>,
    ),
  );
}

it("uses the actual warning and comparison dialog while simulating repair without Git IPC", async () => {
  await renderSettings();
  await chooseOption(
    container.querySelector<HTMLElement>('[aria-label="Git identity state"]')!,
    "Commit identity mismatch",
  );

  expect(container.textContent).toContain("Global Git settings differ from Work");
  expect(container.querySelectorAll("aside")).toHaveLength(1);
  expect(container.querySelector("main aside")).toBeNull();
  expect(container.querySelector("aside")?.textContent).not.toContain("Simulation");
  expect(container.textContent).not.toContain("Reset preview");

  await click("Review global Git settings");

  const dialog = document.querySelector('[role="dialog"]')!;

  expect(dialog.textContent).toContain("Example (different identity)");
  expect(dialog.textContent).toContain("simulation@example.invalid");
  expect(dialog.textContent).toContain("work@example.com");
  expect(dialog.textContent).toContain("your Git configuration stays unchanged");

  await click("Apply profile globally");

  expect(useSimulationStore.getState().gitIdentity).toBe("matched");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("Identity matches the profile");
  expect(inspect).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();

  await chooseOption(
    container.querySelector<HTMLElement>('[aria-label="Git identity state"]')!,
    "Use live status",
  );

  expect(useSimulationStore.getState().gitIdentity).toBeNull();
  expect(container.querySelector("aside")).toBeNull();
});

it("simulates repair failure, follows the active profile, and cancels queued simulated actions on reset", async () => {
  await renderSettings();
  await chooseOption(
    container.querySelector<HTMLElement>('[aria-label="Git identity state"]')!,
    "Identity mismatch with repair failure",
  );
  await click("Review global Git settings");
  await click("Apply profile globally");

  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Simulated repair failure",
  );

  await act(async () =>
    useAppStore.setState({
      activeIdentity: {
        ...profile,
        id: "home",
        name: "Home",
        gitName: "Home Author",
        gitEmail: "home@example.com",
      },
    }),
  );

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("Global Git settings differ from Home");

  await click("Review global Git settings");

  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "simulation@example.invalid",
  );

  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Apply profile globally"]')!.click();
    useSimulationStore.getState().setGitIdentity(null);
  });

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(apply).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
});

it("restores live inspection on reset and clears every simulation when Developer Settings is disabled", async () => {
  useSimulationStore.getState().setGitIdentity("mismatch");
  useSimulationStore.getState().setUpdatePhase("available");
  usePreferencesStore.setState({
    values: {
      ...usePreferencesStore.getState().values,
      syncGlobalGitConfig: builtInSetting("syncGlobalGitConfig"),
    },
  });

  await act(async () => root.render(<GlobalGitWarning onReview={() => {}} />));

  expect(container.textContent).toContain("Global Git settings differ from Work");
  expect(inspect).not.toHaveBeenCalled();

  await act(async () => useSimulationStore.getState().reset());

  expect(inspect).toHaveBeenCalledOnce();
  expect(container.querySelector("aside")).toBeNull();

  await act(async () => {
    useSimulationStore.getState().setGitIdentity("mismatch");
    useSimulationStore.getState().setUpdatePhase("available");
  });
  await act(async () =>
    usePreferencesStore.setState({
      values: {
        ...usePreferencesStore.getState().values,
        developerSettingsEnabled: builtInSetting("developerSettingsEnabled"),
      },
    }),
  );

  expect(useSimulationStore.getState().gitIdentity).toBeNull();
  expect(useSimulationStore.getState().update).toBeNull();

  useSimulationStore.getState().setGitIdentity("mismatch");
  useSimulationStore.getState().setUpdatePhase("available");

  expect(useSimulationStore.getState().gitIdentity).toBeNull();
  expect(useSimulationStore.getState().update).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});

it("keeps application simulations active while a different profile's preferences load", async () => {
  useSimulationStore.getState().setGitIdentity("mismatch");
  useSimulationStore.getState().setUpdatePhase("available");

  const loading = usePreferencesStore.getState().load({ profileId: "home" });

  expect(useSimulationStore.getState().gitIdentity).toBe("mismatch");
  expect(useSimulationStore.getState().update?.phase).toBe("available");

  await loading;

  expect(useSimulationStore.getState().gitIdentity).toBe("mismatch");
  expect(useSimulationStore.getState().update?.phase).toBe("available");
});

it("explains identity versus exact subkey selection without hiding the global configuration difference", async () => {
  const primary = "0123456789ABCDEF0123456789ABCDEF01234567";
  const subkey = "89ABCDEF89ABCDEF89ABCDEF89ABCDEF89ABCDEF";
  const signingProfile: Identity = {
    ...profile,
    signing: { format: "gpg", keyRef: `${subkey}!`, signCommits: true },
  };
  useAppStore.setState({ activeIdentity: signingProfile });
  usePreferencesStore.setState({
    values: {
      ...usePreferencesStore.getState().values,
      syncGlobalGitConfig: builtInSetting("syncGlobalGitConfig"),
    },
  });
  inspect.mockResolvedValue({
    ok: true,
    value: {
      profileId: profile.id,
      global: Object.entries(profileGitConfig(signingProfile)).map(([key, value]) => ({
        key,
        value: key === "user.signingkey" ? primary : value,
      })),
    },
  });
  const listKeys = vi.fn(async () => ({
    ok: true,
    value: [
      {
        fingerprint: primary,
        keyId: primary.slice(-16),
        userIds: ["Work Author <work@example.com>"],
        signingKeys: [{ fingerprint: subkey, expiresAt: null }],
        expiresAt: null,
      },
    ],
  }));
  vi.stubGlobal("eda", {
    identity: { inspectGit: inspect, reapplyGlobal: apply, listGpgSigningKeys: listKeys },
  });
  await act(async () => root.render(<GlobalGitWarning onReview={() => {}} />));
  expect(container.textContent).toContain("Global Git settings differ");
  expect(listKeys).not.toHaveBeenCalled();
  await click("Review global Git settings");
  const dialog = document.querySelector('[role="dialog"]')!;
  const cells = dialog.querySelectorAll("td");
  expect(cells[0]?.textContent).toContain("Automatic selection");
  expect(cells[0]?.textContent).toContain(primary);
  expect(cells[1]?.textContent).toContain("Signing subkey · exact selection");
  expect(cells[1]?.textContent).toContain(`${subkey}!`);
  expect(dialog.textContent).toContain("Same GPG identity, different signing-key selection.");
  expect(apply).not.toHaveBeenCalled();
});
