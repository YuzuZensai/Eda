import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { builtInSetting } from "@shared/preferences/settings";
import { ok } from "@shared/errors";
import { useScopedSetting } from "@renderer/features/settings/hooks/useScopedSetting";

const profile = vi.hoisted(() => ({ id: "first", switching: null as string | null }));
vi.mock("@renderer/stores/app-store", () => ({
  useAppStore: Object.assign(
    (
      select: (state: {
        activeIdentity: { id: string };
        switchingIdentityId: string | null;
      }) => unknown,
    ) => select({ activeIdentity: profile, switchingIdentityId: profile.switching }),
    { getState: () => ({ activeIdentity: profile, switchingIdentityId: profile.switching }) },
  ),
}));

it("retains the confirmed value on refresh but clears it across profile changes and failed reads", async () => {
  const { usePreferencesStore } = await import("@renderer/stores/preferences-store");
  const previous = usePreferencesStore.getState();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let reject!: (reason: Error) => void;
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(
      ok({
        ...builtInSetting("uiZoom"),
        value: 150,
        source: { kind: "profile", profileId: "first" },
      }),
    )
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
  vi.stubGlobal("eda", { settings: { resolve } });
  const container = document.createElement("div");
  const root = createRoot(container);
  function Example() {
    const setting = useScopedSetting("uiZoom", "profile");
    return (
      <output data-reading={setting.reading} data-unavailable={setting.unavailable}>
        {setting.resolved.value}
      </output>
    );
  }
  try {
    await act(async () => root.render(<Example />));
    expect(container.textContent).toBe("150");
    await act(async () => usePreferencesStore.setState({ values: { ...previous.values } }));
    expect(container.textContent).toBe("150");
    expect(container.querySelector("output")?.dataset["reading"]).toBe("true");
    profile.id = "second";
    await act(async () => root.render(<Example />));
    expect(container.textContent).toBe(String(builtInSetting("uiZoom").value));
    expect(container.querySelector("output")?.dataset["reading"]).toBe("true");
    await act(async () => reject(new Error("offline")));
    expect(container.textContent).toBe(String(builtInSetting("uiZoom").value));
    expect(container.querySelector("output")?.dataset["reading"]).toBe("false");
    expect(container.querySelector("output")?.dataset["unavailable"]).toBe("true");
  } finally {
    await act(async () => root.unmount());
    profile.id = "first";
    usePreferencesStore.setState(previous, true);
    vi.unstubAllGlobals();
  }
});

it("keeps scoped preferences disabled and reports a rejected read", async () => {
  const { ScopedPreferences } = await import("@renderer/features/settings/ScopedPreferences");
  const { usePreferencesStore } = await import("@renderer/stores/preferences-store");
  const previous = usePreferencesStore.getState();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { settings: { resolve: vi.fn().mockRejectedValue(new Error("offline")) } });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ScopedPreferences owner="profile" section="appearance" />));
    expect(container.querySelector("fieldset")?.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector("fieldset")?.hasAttribute("inert")).toBe(true);
    expect(usePreferencesStore.getState().error?.message).toBe(
      "Could not read application preferences.",
    );
  } finally {
    await act(async () => root.unmount());
    usePreferencesStore.setState(previous, true);
    vi.unstubAllGlobals();
  }
});

it("ignores reads from a profile being removed and resumes after the transition", async () => {
  const { usePreferencesStore } = await import("@renderer/stores/preferences-store");
  const previous = usePreferencesStore.getState();
  let reject!: (reason: Error) => void;
  const resolve = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(ok(builtInSetting("uiZoom")));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { settings: { resolve } });
  usePreferencesStore.setState({ error: null });
  const container = document.createElement("div");
  const root = createRoot(container);
  function Example() {
    const setting = useScopedSetting("uiZoom", "profile");
    return <output>{setting.resolved.value}</output>;
  }
  try {
    await act(async () => root.render(<Example />));
    profile.switching = "first";
    await act(async () => reject(new Error("profile deleted")));
    await act(async () => root.render(<Example />));
    expect(usePreferencesStore.getState().error).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    profile.id = "second";
    profile.switching = null;
    await act(async () => root.render(<Example />));
    expect(resolve).toHaveBeenLastCalledWith("uiZoom", { profileId: "second" });
    expect(container.textContent).toBe(String(builtInSetting("uiZoom").value));
  } finally {
    await act(async () => root.unmount());
    profile.id = "first";
    profile.switching = null;
    usePreferencesStore.setState(previous, true);
    vi.unstubAllGlobals();
  }
});

it("keeps an editable draft while an object-valued setting is unavailable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { settings: { resolve: () => new Promise(() => {}) } });
  const container = document.createElement("div");
  const root = createRoot(container);
  function Example() {
    const { resolved } = useScopedSetting("mergeTool", "application");
    const [draft, setDraft] = useState("");
    useEffect(() => setDraft(resolved.value.executable), [resolved]);
    return <button onClick={() => setDraft("/tools/merge")}>{draft}</button>;
  }
  try {
    await act(async () => root.render(<Example />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("/tools/merge");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
