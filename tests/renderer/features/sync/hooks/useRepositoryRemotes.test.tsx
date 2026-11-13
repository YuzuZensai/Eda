import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, type Result } from "@shared/errors";
import type { RemoteState } from "@shared/integrations/remotes";
import { useRepositoryRemotes } from "@renderer/features/sync/hooks/useRepositoryRemotes";
import { useRepositoryStore } from "@renderer/stores/repository-store";

let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof useRepositoryRemotes>;
const state = (branch: string): RemoteState => ({
  remotes: [{ name: "origin", fetchUrls: [], pushUrls: [] }],
  branches: [{ name: branch, oid: "a".repeat(40), remote: false, isHead: true, upstreamState: "" }],
});
const inspect = vi.fn();
function View({ repositoryId }: { repositoryId: string }) {
  api = useRepositoryRemotes(repositoryId);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  inspect.mockReset().mockResolvedValue(ok(state("main")));
  vi.stubGlobal("eda", { remotes: { inspect } });
  vi.spyOn(useRepositoryStore.getState(), "syncFromDisk").mockResolvedValue();
  useRepositoryStore.setState({ repositoryId: "repo" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<View repositoryId="repo" />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("blocks duplicate actions before React renders their busy state", async () => {
  let finish!: (value: Result<void>) => void;
  const work = vi.fn(
    () =>
      new Promise<Result<void>>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    const first = api.run("main.remoteService.configureRemote", work);
    const duplicate = api.run("main.remoteService.configureRemote", work);
    expect(work).toHaveBeenCalledOnce();
    finish(ok(undefined));
    await Promise.all([first, duplicate]);
  });
  expect(api.busy).toBeNull();
});

it("handles transport rejections and allows a retry", async () => {
  await act(async () => {
    await expect(
      api.run("main.remoteService.configureRemote", async () => {
        throw new Error("transport closed");
      }),
    ).resolves.toBeUndefined();
  });
  expect(api.error).toBeTruthy();
  expect(api.busy).toBeNull();
  const work = vi.fn(async () => ok(undefined));
  await act(async () => api.run("main.remoteService.configureRemote", work));
  expect(work).toHaveBeenCalledOnce();
  expect(api.error).toBeNull();
});

it("handles rejected initial loads without an unhandled promise", async () => {
  inspect.mockRejectedValueOnce(new Error("transport closed"));
  await act(async () => root.render(<View repositoryId="other" />));
  expect(api.error).toBeTruthy();
});

it("clears the old repository's tracking and remote edits when the target changes", async () => {
  await act(async () => {
    api.setBranch("old-branch");
    api.setUpstream("refs/remotes/old/branch");
    api.setEdit({ kind: "remove", name: "old-remote" });
    api.setRemove("old-remote");
  });
  inspect.mockResolvedValueOnce(ok(state("develop")));
  await act(async () => root.render(<View repositoryId="other" />));
  expect(api.branch).toBe("develop");
  expect(api.upstream).toBe("");
  expect(api.edit).toEqual({ kind: "add", name: "origin", url: "" });
  expect(api.remove).toBeNull();
});

it("does not refresh the new repository from a completed action's stale reload", async () => {
  let finish!: (value: Result<RemoteState>) => void;
  inspect.mockImplementationOnce(
    () =>
      new Promise<Result<RemoteState>>((resolve) => {
        finish = resolve;
      }),
  );
  let action!: Promise<void>;
  await act(async () => {
    action = api.run("main.remoteService.configureRemote", async () => ok(undefined));
  });
  inspect.mockResolvedValueOnce(ok(state("develop")));
  await act(async () => root.render(<View repositoryId="other" />));
  await act(async () => {
    finish(ok(state("main")));
    await action;
  });
  expect(useRepositoryStore.getState().syncFromDisk).not.toHaveBeenCalled();
  expect(api.branch).toBe("develop");
});
