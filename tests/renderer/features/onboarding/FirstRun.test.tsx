import { fillInput } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { builtInSetting } from "@shared/preferences/settings";
import { defaultCommitPrefixes } from "@shared/preferences/commit-prefix";
import { FirstRun } from "@renderer/features/onboarding/FirstRun";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";

vi.mock("@renderer/features/onboarding/ConnectionsStep", () => ({
  ConnectionsStep: ({ profileId }: { profileId: string }) => (
    <div data-testid="connections" data-profile-id={profileId}>
      Connection controls
    </div>
  ),
}));

let root: Root;
let container: HTMLDivElement;
let app: ReturnType<typeof useAppStore.getState>;
let preferences: ReturnType<typeof usePreferencesStore.getState>;
const create = vi.fn(async () => true);
const save = vi.fn(async () => true);
const button = (text: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => {
    const label = item.cloneNode(true) as HTMLElement;
    label.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    return label.textContent?.trim() === text;
  })!;
const input = (label: string) => {
  const element = Array.from(container.querySelectorAll("label")).find(
    (item) => item.textContent === label,
  )!;
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(element.htmlFor)}`)!;
};

async function click(text: string) {
  await act(async () => button(text).click());
}

async function submit() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  document.documentElement.style.setProperty("--duration-fade", "240ms");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", {
    app: {
      getGlobalGitUser: vi.fn(async () => ({
        ok: true,
        value: { name: "  Eda   Example ", email: "eda@example.com" },
      })),
    },
  });
  app = useAppStore.getState();
  preferences = usePreferencesStore.getState();
  create.mockReset().mockResolvedValue(true);
  save.mockReset().mockResolvedValue(true);
  useAppStore.setState({ createIdentity: create, error: null });
  usePreferencesStore.setState({
    set: save,
    context: {},
    error: null,
    values: {
      ...preferences.values,
      theme: builtInSetting("theme"),
      reducedMotion: builtInSetting("reducedMotion"),
      accentHue: builtInSetting("accentHue"),
      syncGlobalGitConfig: builtInSetting("syncGlobalGitConfig"),
      conventionalCommitsEnabled: builtInSetting("conventionalCommitsEnabled"),
      commitPrefixes: builtInSetting("commitPrefixes"),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<FirstRun />));
  await click("Get started");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.style.removeProperty("--duration-fade");
  useAppStore.setState(app);
  usePreferencesStore.setState(preferences);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("imports an editable first-name suggestion, retains inputs across steps, and saves global choices before creating a profile", async () => {
  expect(button("Continue").disabled).toBe(false);
  expect(input("Profile name").value).toBe("Eda");
  expect(input("Git author name").value).toBe("Eda   Example");

  await fillInput(input("Profile name"), "Personal");
  expect(input("Profile name").value).toBe("Personal");

  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await click("Continue");
  expect(document.activeElement?.textContent).toBe("Make Eda yours");

  await click("Dark");
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(document.documentElement.dataset["reducedMotion"]).toBe("true");

  await act(async () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Pink"]')!.click(),
  );
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Custom"]')!.click(),
  );

  const picker = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Custom accent color"]',
  )!;
  const hex = picker.querySelector<HTMLInputElement>("input:not([type])")!;

  await fillInput(hex, "#bad");
  expect(hex.getAttribute("aria-invalid")).toBe("true");

  const color = picker.querySelector<HTMLInputElement>('input[type="color"]')!;

  await fillInput(color, "#c46c9e");
  await act(async () => color.dispatchEvent(new Event("change", { bubbles: true })));
  await act(async () =>
    hex.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector('[aria-label="Custom accent color"]')).toBeNull();
  expect(document.documentElement.dataset["theme"]).toBe("eda-dark");
  expect(save).not.toHaveBeenCalled();

  await click("Back");
  expect(input("Profile name").value).toBe("Personal");

  await click("Continue");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Custom"]')!.checked).toBe(
    true,
  );

  await click("Continue");
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[name="onboarding-commit-style"][value="true"]')!
      .click(),
  );
  await click("With emojis");
  save.mockResolvedValueOnce(false);
  await submit();
  expect(create).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Your space is ready.");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");

  await submit();
  expect(save).toHaveBeenCalledWith(
    "theme",
    { kind: "application" },
    { ...builtInSetting("theme").value, mode: "dark" },
  );
  expect(save).toHaveBeenCalledWith("accentHue", { kind: "application" }, "#c46c9e");
  expect(save).toHaveBeenCalledWith("reducedMotion", { kind: "application" }, true);
  expect(save).toHaveBeenCalledWith("conventionalCommitsEnabled", { kind: "application" }, true);
  expect(save).toHaveBeenCalledWith(
    "commitPrefixes",
    { kind: "application" },
    defaultCommitPrefixes(true),
  );
  expect(container.textContent).toContain("Connect your tools");
  expect(container.textContent).not.toContain("Your space is ready.");
  await click("Start using Eda");
  expect(container.textContent).toContain("Your space is ready.");
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      name: "Personal",
      gitName: "Eda   Example",
      gitEmail: "eda@example.com",
      hue: builtInSetting("accentHue").value,
    }),
    { syncGlobalGitConfig: false },
  );
});

it("retains the emoji preset when switching back to free-form messages", async () => {
  const finishFade = async () => {
    expect(container.querySelector('.welcome-commit-layer[data-changing="true"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(260));
    expect(container.querySelector('.welcome-commit-layer[data-changing="true"]')).toBeNull();
  };
  const messages = () =>
    [...container.querySelectorAll(".welcome-commit-popup code")].map((node) => node.textContent!);

  expect(messages().every((message) => /\p{Extended_Pictographic}/u.test(message))).toBe(true);

  await click("Continue");
  expect(messages().every((message) => /\p{Extended_Pictographic}/u.test(message))).toBe(true);

  await click("Continue");
  expect(messages().every((message) => /\p{Extended_Pictographic}/u.test(message))).toBe(true);
  await finishFade();
  expect(messages().every((message) => !message.includes(":"))).toBe(true);

  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[name="onboarding-commit-style"][value="true"]')!
      .click(),
  );
  await click("Plain");
  await finishFade();
  expect(messages().every((message) => /^[a-z]+: /.test(message))).toBe(true);

  await click("With emojis");
  await finishFade();
  expect(messages().every((message) => /\p{Extended_Pictographic}/u.test(message))).toBe(true);

  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[name="onboarding-commit-style"][value="false"]')!
      .click(),
  );
  await finishFade();
  expect(messages().every((message) => !message.includes(":"))).toBe(true);

  await submit();
  expect(create).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalledWith("conventionalCommitsEnabled", expect.anything(), true);
  expect(save).toHaveBeenCalledWith(
    "commitPrefixes",
    { kind: "application" },
    defaultCommitPrefixes(true),
  );
});

it("preserves user edits when Git details arrive late", async () => {
  await act(async () => root.render(null));

  let complete!: (result: Awaited<ReturnType<typeof window.eda.app.getGlobalGitUser>>) => void;

  vi.mocked(window.eda.app.getGlobalGitUser).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => root.render(<FirstRun />));
  await click("Get started");
  await fillInput(input("Profile name"), "Work");
  await fillInput(input("Git author name"), "A");
  await fillInput(input("Git author name"), "");
  await act(async () =>
    complete({ ok: true, value: { name: "Eda Example", email: "eda@example.com" } }),
  );
  expect(input("Profile name").value).toBe("Work");
  expect(input("Git author name").value).toBe("");
  expect(input("Git email").value).toBe("eda@example.com");
});

it("offers optional connections for the saved profile and finishes without creating another profile", async () => {
  create.mockImplementationOnce(async () => {
    useAppStore.setState({
      activeIdentity: { id: "new-profile" } as NonNullable<typeof app.activeIdentity>,
    });
    return true;
  });
  await click("Continue");
  await click("Continue");
  await submit();
  expect(
    container.querySelector('[data-testid="connections"]')?.getAttribute("data-profile-id"),
  ).toBe("new-profile");
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Connect");
  await submit();
  expect(container.textContent).toContain("Connect your tools");
  await click("Start using Eda");
  expect(container.textContent).toContain("Your space is ready.");
  expect(create).toHaveBeenCalledOnce();
});

it("keeps profile creation failures on the commit step for retry", async () => {
  create.mockResolvedValueOnce(false);
  await click("Continue");
  await click("Continue");
  await submit();
  expect(container.textContent).toContain("Find your commit style");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be created");
  await submit();
  expect(container.textContent).toContain("Connect your tools");
});

it("keeps branch markers in sync with every setup step and back navigation", async () => {
  const expectStep = (step: number) => {
    const count = container.querySelectorAll('nav[aria-label="Setup progress"] li').length;
    for (const branch of container.querySelectorAll(".welcome-branch")) {
      const markers = [...branch.querySelectorAll(".welcome-stations circle")];
      expect(markers).toHaveLength(count);
      expect(markers.filter((marker) => marker.getAttribute("data-current") === "true")).toEqual([
        markers[step - 1],
      ]);
      expect(
        markers.filter((marker) => marker.getAttribute("data-reached") === "true"),
      ).toHaveLength(step);
    }
  };
  expectStep(1);
  await click("Continue");
  expectStep(2);
  await click("Back");
  expectStep(1);
  await click("Continue");
  await click("Continue");
  expectStep(3);
  await submit();
  expectStep(4);
  await click("Start using Eda");
  expect(container.querySelectorAll('.welcome-stations circle[r="8"]')).toHaveLength(0);
  expect(container.querySelectorAll('.welcome-stations circle[data-reached="true"]')).toHaveLength(
    8,
  );
});

it("opens the workspace only after the welcome screen", async () => {
  const complete = vi.fn();
  await act(async () => root.render(<FirstRun onComplete={complete} />));
  await click("Continue");
  await click("Continue");
  await submit();
  await click("Start using Eda");
  expect(complete).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Your space is ready.");
  await click("Skip for now");
  expect(complete).toHaveBeenCalledWith(false);
  expect(create).toHaveBeenCalledOnce();
});

it("starts the tour only when requested after setup", async () => {
  const complete = vi.fn();
  await act(async () => root.render(<FirstRun onComplete={complete} />));
  await click("Continue");
  await click("Continue");
  await submit();
  await click("Start using Eda");
  await click("Take a tour");
  expect(complete).toHaveBeenCalledWith(true);
});
