import { errorFixture } from "../../helpers/error";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, err } from "@shared/errors";
import { profileGitConfig, type Identity } from "@shared/identity/identity";
import type { ProfileGitInspection } from "@shared/identity/profile-session";
import { GlobalGitWarning } from "@renderer/features/profiles/GlobalGitWarning";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";

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
const app = useAppStore.getState();
const preferences = usePreferencesStore.getState();
let root: Root;
let container: HTMLDivElement;
let inspection: ProfileGitInspection;
let inspect: ReturnType<typeof vi.fn>;
let apply: ReturnType<typeof vi.fn>;
let review: ReturnType<typeof vi.fn<() => void>>;

function configuration(identity = profile): ProfileGitInspection {
  return {
    profileId: identity.id,
    global: Object.entries(profileGitConfig(identity)).map(([key, value]) => ({
      key,
      ...(value === undefined ? {} : { value }),
      scope: "global",
      origin: "file:/sandbox/gitconfig",
    })),
    repository: null,
    localOverrides: null,
  };
}

function drift(email = "outside@example.com") {
  inspection = configuration();
  inspection.global.find((entry) => entry.key === "user.email")!.value = email;
}

async function openDetails() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Review global Git settings"]')!
      .click(),
  );
}

async function render() {
  await act(async () => root.render(<GlobalGitWarning onReview={review} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAppStore.setState({ activeIdentity: profile, switchingIdentityId: null });
  usePreferencesStore.setState({
    context: { profileId: profile.id },
    values: {
      ...preferences.values,
      syncGlobalGitConfig: { ...preferences.values.syncGlobalGitConfig, value: true },
    },
  });
  inspection = configuration();
  inspect = vi.fn(async () => ok(inspection));
  apply = vi.fn(async () => {
    inspection = configuration();
    return ok(undefined);
  });
  review = vi.fn();
  vi.stubGlobal("eda", { identity: { inspectGit: inspect, reapplyGlobal: apply } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(app, true);
  usePreferencesStore.setState(preferences, true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("detects external changes, stays visible, and writes only on explicit apply", async () => {
  await render();
  expect(container.querySelector("aside")).toBeNull();
  drift();
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(document.body.textContent).toContain("Global Git settings differ from Work");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await openDetails();
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
  expect(document.querySelector('[role="dialog"]')?.closest("aside")).toBeNull();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click(),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector("aside")).not.toBeNull();
  expect(apply).not.toHaveBeenCalled();
  await openDetails();
  expect(document.body.textContent).toContain("outside@example.com");
  expect(document.body.textContent).toContain("file:/sandbox/gitconfig");
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(container.querySelector("aside")).not.toBeNull();
  expect(container.querySelector('[aria-label*="Dismiss"]')).toBeNull();
  expect(apply).not.toHaveBeenCalled();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Apply profile globally"]')!.click(),
  );
  expect(apply).toHaveBeenCalledWith("work");
  expect(container.querySelector("aside")).toBeNull();
});

it("hides when effective sync is disabled and checks again when it is enabled", async () => {
  drift();
  usePreferencesStore.setState({
    values: {
      ...preferences.values,
      syncGlobalGitConfig: { ...preferences.values.syncGlobalGitConfig, value: false },
    },
  });
  await render();
  expect(inspect).not.toHaveBeenCalled();
  expect(container.querySelector("aside")).toBeNull();
  await act(async () =>
    usePreferencesStore.setState({
      values: {
        ...preferences.values,
        syncGlobalGitConfig: { ...preferences.values.syncGlobalGitConfig, value: true },
      },
    }),
  );
  expect(container.querySelector("aside")).not.toBeNull();
  await act(async () =>
    usePreferencesStore.setState({
      values: {
        ...preferences.values,
        syncGlobalGitConfig: { ...preferences.values.syncGlobalGitConfig, value: false },
      },
    }),
  );
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(container.querySelector("aside")).toBeNull();
  expect(inspect).toHaveBeenCalledTimes(1);
});

it("rechecks on focus, clears after an external repair, and opens the settings action", async () => {
  drift();
  await render();
  await openDetails();
  const settings = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Global Git settings",
  )!;
  await act(async () => settings.click());
  expect(review).toHaveBeenCalledOnce();
  inspection = configuration();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.querySelector("aside")).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});

it("keeps a failed repair actionable and requires verified readback before clearing", async () => {
  drift();
  apply.mockResolvedValueOnce(
    err(
      errorFixture({
        kind: "config-write-refused",
        operation: "apply",
        message: "Git configuration is read-only.",
      }),
    ),
  );
  await render();
  await openDetails();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Apply profile globally"]')!.click(),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Git configuration is read-only.",
  );
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(document.body.textContent).toContain("Git configuration is read-only.");
  apply.mockResolvedValueOnce(ok(undefined));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Apply profile globally"]')!.click(),
  );
  expect(document.body.textContent).toContain("Global Git settings still differ.");
  expect(container.querySelector("aside")).not.toBeNull();
});

it("ignores an old profile's in-flight inspection after switching profiles", async () => {
  let resolve!: (value: ReturnType<typeof ok<ProfileGitInspection>>) => void;
  inspect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  const old = configuration();
  old.global.find((entry) => entry.key === "user.email")!.value = "old@example.com";
  const home = { ...profile, id: "home", name: "Home", gitEmail: "home@example.com" };
  inspection = configuration(home);
  await act(async () => {
    useAppStore.setState({ activeIdentity: home });
    usePreferencesStore.setState({ context: { profileId: home.id } });
  });
  await act(async () => resolve(ok(old)));
  expect(container.querySelector("aside")).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});

it("reports inspection failures with a retry instead of silently claiming settings match", async () => {
  inspect.mockRejectedValueOnce(new Error("unreadable"));
  await render();
  expect(document.body.textContent).toContain("Could not check global Git settings");
  await openDetails();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Check global Git settings"]')!.click(),
  );
  expect(container.querySelector("aside")).toBeNull();
});
