import { act } from "react";
import { createRoot } from "react-dom/client";
import { ok, type Result } from "@shared/errors";
import type { TagSummary } from "@shared/repository/repository-write";
import type { RepositorySummary } from "@shared/repository/repository";
import type { Identity } from "@shared/identity/identity";
import { useRepositoryNavigation } from "@renderer/repository/hooks/useRepositoryNavigation";
import { useAppStore } from "@renderer/stores/app-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useSessionStore } from "@renderer/stores/session-store";
import { deferred } from "../../helpers/deferred";

it.each([
  ["found", "switch"],
  ["missing", "switch"],
  ["found", "reopen"],
  ["missing", "reopen"],
  ["found", "stay"],
  ["missing", "stay"],
])(
  "handles a %s navigation reference only in its original context (%s)",
  async (outcome, navigation) => {
    const app = useAppStore.getState();
    const repository = useRepositoryStore.getState();
    const session = useSessionStore.getState();
    const pending = deferred<Result<TagSummary[]>>();
    const opened: RepositorySummary = {
      id: "target",
      identityId: "profile",
      name: "target",
      path: "/target",
      available: true,
      favourite: false,
    };
    const profile: Identity = {
      id: "profile",
      name: "Profile",
      gitName: "Eda",
      gitEmail: "eda@example.com",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const tags = vi.fn(() => pending.promise);
    const showWorkspace = vi.fn();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("eda", {
      app: { takeNavigation: async () => ok([{ path: "/target", ref: "main" }]) },
      events: { onNavigation: () => () => {} },
      repository: {
        open: async () => ok(opened),
        list: async () => ok([opened, { ...opened, id: "other" }]),
        status: async () =>
          ok({ branch: { ahead: 0, behind: 0, detached: false, unborn: false }, changes: [] }),
        history: async () => ok({ commits: [], nextOffset: null }),
        commitDiff: async () => ok({ files: [] }),
        listBranches: async () =>
          ok(
            outcome === "found"
              ? [{ name: "main", oid: "commit", remote: false, isHead: true }]
              : [],
          ),
        listTags: tags,
      },
    });
    useSessionStore.setState({ snapshot: null });
    useRepositoryStore.getState().clear();
    useAppStore.setState({
      activeIdentity: profile,
      repositories: [opened, { ...opened, id: "other" }],
      switchingIdentityId: null,
      error: null,
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    function Harness() {
      useRepositoryNavigation("profile", showWorkspace);
      return null;
    }

    try {
      await act(async () => root.render(<Harness />));
      expect(tags).toHaveBeenCalledWith("target");
      if (navigation !== "stay") {
        useAppStore.getState().selectRepository("other");
        await useRepositoryStore.getState().open("other", "profile", true);
        if (navigation === "reopen") {
          useAppStore.getState().selectRepository("target");
          await useRepositoryStore.getState().open("target", "profile", true);
        }
      }
      await act(async () => {
        pending.resolve(ok([]));
      });
      expect(useAppStore.getState().selectedRepositoryId).toBe(
        navigation === "switch" ? "other" : "target",
      );
      if (navigation === "stay" && outcome === "found")
        expect(useRepositoryStore.getState().selection).toEqual({ kind: "commit", oid: "commit" });
      else expect(useRepositoryStore.getState().selection).toBeNull();
      if (navigation === "stay" && outcome === "missing")
        expect(useAppStore.getState().error?.code).toBe(
          "useRepositoryNavigation.theRequestedReferenceWasNotFoundTheRepository",
        );
      else expect(useAppStore.getState().error).toBeNull();
    } finally {
      await act(async () => root.unmount());
      useAppStore.setState(app);
      useRepositoryStore.setState(repository);
      useSessionStore.setState(session);
      vi.unstubAllGlobals();
    }
  },
);
