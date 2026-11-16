import { ACTION_FEEDBACK } from "@renderer/motion";
import { errorFixture } from "../../../../helpers/error";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, err } from "@shared/errors";
import { builtInSetting, type SettingKey } from "@shared/preferences/settings";
import { useDirectFetch } from "@renderer/features/sync/hooks/useDirectFetch";
import { RepositorySyncActions } from "@renderer/features/sync/RepositorySyncActions";
import { useAppStore } from "@renderer/stores/app-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useShellStore } from "@renderer/stores/shell-store";

let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof useDirectFetch>;
const inspect = vi.fn();
const fetchRemote = vi.fn();
const resolve = vi.fn();
async function perform(work: () => Promise<unknown>) {
  await act(async () => {
    const pending = work();
    await vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending);
    await pending;
  });
}

function Harness() {
  api = useDirectFetch("repo");
  return null;
}
beforeEach(async () => {
  vi.useFakeTimers();
  useShellStore.setState({ request: null });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAppStore.setState({
    selectedRepositoryId: "repo",
    activeIdentity: { id: "profile" } as never,
    switchingIdentityId: null,
  });
  useRepositoryStore.setState({
    repositoryId: "repo",
    identityId: "profile",
    phase: "ready",
    writing: false,
  });
  vi.spyOn(useRepositoryStore.getState(), "syncFromDisk").mockResolvedValue();
  inspect.mockReset().mockResolvedValue(
    ok({
      branches: [{ isHead: true, upstream: "team/main" }],
      remotes: [
        { name: "origin", fetchUrls: ["https://example.com/origin"] },
        { name: "team", fetchUrls: ["https://example.com/team"] },
      ],
    }),
  );
  fetchRemote.mockReset().mockResolvedValue(ok("Fetched."));
  resolve.mockReset().mockImplementation(async (key: SettingKey) => ok(builtInSetting(key)));
  vi.stubGlobal("eda", { remotes: { inspect, fetch: fetchRemote }, settings: { resolve } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useShellStore.setState({ request: null });
  useAppStore.setState({ switchingIdentityId: null });
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("fetches the upstream remote directly with repository defaults", async () => {
  await perform(() => api.fetch());
  expect(fetchRemote).toHaveBeenCalledExactlyOnceWith({
    repositoryId: "repo",
    remote: "team",
    prune: true,
    tags: false,
  });
  expect(resolve).toHaveBeenCalledWith("fetchPrune", {
    profileId: "profile",
    repositoryId: "repo",
  });
  expect(api.message).toBe("Fetched team.");
});
it("fetches all remotes sequentially", async () => {
  await perform(() => api.fetch(null));
  expect(fetchRemote.mock.calls.map(([request]) => request.remote)).toEqual(["origin", "team"]);
  expect(api.message).toBe("Fetched all remotes.");
});
it("honors the saved all-tags preference", async () => {
  resolve.mockImplementation(async (key: SettingKey) =>
    ok(key === "fetchTags" ? { value: true } : builtInSetting(key)),
  );
  await perform(() => api.fetch());
  expect(fetchRemote).toHaveBeenCalledWith(expect.objectContaining({ tags: true }));
});
it("fetches all tags once without changing the next fetch's repository defaults", async () => {
  await perform(() => api.fetch(undefined, undefined, { allTags: true }));
  expect(fetchRemote).toHaveBeenLastCalledWith(expect.objectContaining({ tags: true }));
  await perform(() => api.fetch());
  expect(fetchRemote).toHaveBeenLastCalledWith(expect.objectContaining({ tags: false }));
});
it("preserves the all-tags override when retrying an HTTPS authentication failure", async () => {
  fetchRemote.mockResolvedValueOnce(
    err(errorFixture({ kind: "auth-failed", message: "Authentication failed." })),
  );
  await perform(() => api.fetch(undefined, undefined, { allTags: true }));
  await perform(() =>
    api.fetch(api.authentication!, { username: "user", password: "token" }, api.retryOptions),
  );
  expect(fetchRemote).toHaveBeenLastCalledWith({
    repositoryId: "repo",
    remote: "team",
    prune: true,
    tags: true,
    credentials: { username: "user", password: "token" },
  });
});
it("fetches only a selected tag regardless of the all-tags and pruning defaults", async () => {
  resolve.mockImplementation(async () => ok({ value: true }));
  await perform(() => api.fetch("origin", undefined, { tag: "v1" }));
  expect(fetchRemote).toHaveBeenCalledExactlyOnceWith({
    repositoryId: "repo",
    remote: "origin",
    prune: false,
    tags: false,
    tag: "v1",
  });
});
it("honors the repository setting when pruning is disabled", async () => {
  resolve.mockImplementation(async () => ok({ value: false }));
  await perform(() => api.fetch());
  expect(fetchRemote).toHaveBeenCalledExactlyOnceWith({
    repositoryId: "repo",
    remote: "team",
    prune: false,
    tags: false,
  });
});
it("requests credentials only after an HTTPS auth failure and pins the retry", async () => {
  fetchRemote.mockResolvedValueOnce(
    err(
      errorFixture({ kind: "auth-failed", operation: "fetch", message: "Authentication failed." }),
    ),
  );
  await perform(() => api.fetch());
  expect(api.authentication).toBe("team");
  const credentials = { username: "user", password: "token" };
  await perform(() => api.fetch(api.authentication!, credentials));
  expect(fetchRemote).toHaveBeenLastCalledWith({
    repositoryId: "repo",
    remote: "team",
    prune: true,
    tags: false,
    credentials,
  });
  expect(api.authentication).toBeNull();
});
it("does not start a transfer after switching repository while resolving defaults", async () => {
  resolve.mockImplementation(async () => {
    useAppStore.setState({ selectedRepositoryId: "other" });
    return ok({ value: false });
  });
  await perform(() => api.fetch());
  expect(fetchRemote).not.toHaveBeenCalled();
});
it("prevents duplicate transfers", async () => {
  await perform(() => Promise.all([api.fetch(), api.fetch()]));
  expect(fetchRemote).toHaveBeenCalledOnce();
});
it("does not start fetching while a profile switch is in progress", async () => {
  useAppStore.setState({ switchingIdentityId: "other" });
  await perform(() => api.fetch());
  expect(inspect).not.toHaveBeenCalled();
  expect(fetchRemote).not.toHaveBeenCalled();
  expect(api.busy).toBe(false);
});
it("does not transfer when a profile switch starts while resolving defaults", async () => {
  resolve.mockImplementation(async () => {
    useAppStore.setState({ switchingIdentityId: "other" });
    return ok({ value: false });
  });
  await perform(() => api.fetch());
  expect(fetchRemote).not.toHaveBeenCalled();
  expect(api.message).toBeNull();
  expect(api.busy).toBe(false);
});
it("stops Fetch all on failure without fetching later remotes", async () => {
  fetchRemote.mockResolvedValueOnce(
    err(errorFixture({ kind: "unknown", operation: "fetch", message: "Network unavailable." })),
  );
  await perform(() => api.fetch(null));
  expect(fetchRemote).toHaveBeenCalledOnce();
  expect(api.error).toBe("Network unavailable.");
});
it("clicking the toolbar Fetch starts a transfer without opening a modal", async () => {
  await act(async () => root.render(<RepositorySyncActions />));
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Fetch",
  )!;
  await act(async () => {
    button.click();
    await vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending);
  });
  expect(fetchRemote).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("offers a one-shot all-tags fetch in the toolbar menu", async () => {
  await act(async () => root.render(<RepositorySyncActions />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Fetch options"]')!.click(),
  );
  const fetchTags = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Fetch all tags",
  )!;
  await act(async () => {
    fetchTags.click();
    await vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending);
  });
  expect(fetchRemote).toHaveBeenCalledExactlyOnceWith({
    repositoryId: "repo",
    remote: "team",
    prune: true,
    tags: true,
  });
});

it.each(["github-auth-required", "github-access-required"] as const)(
  "routes %s to Integrations only when Open Settings is clicked",
  async (kind) => {
    fetchRemote.mockResolvedValueOnce(
      err({ kind, operation: "fetch", message: "GitHub connection needs attention" }),
    );
    await act(async () => root.render(<RepositorySyncActions />));
    const button = (label: string) =>
      [...document.querySelectorAll("button")].find((item) => item.textContent === label)!;
    await act(async () => {
      button("Fetch").click();
      await vi.advanceTimersByTimeAsync(ACTION_FEEDBACK.minimumPending);
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Open Settings");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      kind === "github-access-required" ? "GitHub repository access denied" : "Sign in with GitHub",
    );
    expect(document.querySelector('[aria-label="GitHub connection"]')).toBeNull();
    expect(useShellStore.getState().request).toBeNull();
    await act(async () => button("Open Settings").click());
    expect(useShellStore.getState().request).toEqual({ kind: "settings", section: "integrations" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchRemote).toHaveBeenCalledOnce();
  },
);
