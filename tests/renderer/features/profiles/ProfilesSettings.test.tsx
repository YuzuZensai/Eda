import { act } from "react";
import { createRoot } from "react-dom/client";
import { errorText } from "@shared/error-codes";
import { GitError, ok } from "@shared/errors";
import type { Identity } from "@shared/identity/identity";
import { ProfilesSettings } from "@renderer/features/profiles/ProfilesSettings";
import { useAppStore } from "@renderer/stores/app-store";

const profile = (name: string): Identity => ({
  id: name.toLowerCase(),
  name,
  gitName: name,
  gitEmail: "",
  hue: 210,
  signing: { format: "none", signCommits: false },
  createdAt: "now",
  updatedAt: "now",
});

it("moves profiles after saving, prevents overlapping moves, and keeps the active profile", async () => {
  const saved = useAppStore.getState();
  const work = profile("Work");
  const home = profile("Home");
  let complete: (value: ReturnType<typeof ok<Identity[]>>) => void = () => {
    throw new Error("Expected a reorder request");
  };
  const reorder = vi.fn(
    () =>
      new Promise<ReturnType<typeof ok<Identity[]>>>((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { identity: { reorder } });
  useAppStore.setState({
    identities: [work, home],
    activeIdentity: work,
    switchingIdentityId: null,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  };

  try {
    await act(async () => root.render(<ProfilesSettings />));
    expect(button("Move Work up").disabled).toBe(true);
    expect(button("Move Home down").disabled).toBe(true);
    await act(async () => button("Move Home up").click());
    expect(reorder).toHaveBeenCalledWith([home.id, work.id]);
    expect(button("Move Work down").disabled).toBe(true);
    expect(useAppStore.getState().identities).toEqual([work, home]);
    await act(async () => complete(ok([home, work])));
    expect(
      [...container.querySelectorAll("[data-testid]")].map((row) =>
        row.getAttribute("data-testid"),
      ),
    ).toEqual(["profile-home", "profile-work"]);
    expect(useAppStore.getState().activeIdentity).toEqual(work);
    expect(button("Move Home up").disabled).toBe(true);
    expect(button("Move Work up").disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(saved, true);
    vi.unstubAllGlobals();
  }
});

it("keeps the displayed order and reports a failed save", async () => {
  const saved = useAppStore.getState();
  const work = profile("Work");
  const home = profile("Home");
  const refreshIdentities = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", {
    identity: {
      reorder: vi.fn().mockResolvedValue({
        ok: false,
        error: new GitError({
          kind: "invalid-input",
          operation: "Reorder profiles",
          message: errorText("main.persistence.identityRepository.invalidProfileOrder"),
        }).toData(),
      }),
    },
  });
  useAppStore.setState({
    identities: [work, home],
    activeIdentity: work,
    switchingIdentityId: null,
    refreshIdentities,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(<ProfilesSettings />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Move Home up"]')?.click(),
    );
    expect(useAppStore.getState().identities).toEqual([work, home]);
    expect(refreshIdentities).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain(
      "The profile list changed. Refresh it and try again.",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(saved, true);
    vi.unstubAllGlobals();
  }
});
