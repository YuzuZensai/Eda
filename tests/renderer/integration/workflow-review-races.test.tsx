import { errorFixture } from "../../helpers/error";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { err, ok } from "@shared/errors";
import { MergeStartDialog } from "@renderer/features/workflows/MergeStartDialog";
import { MergeAbortDialog } from "@renderer/features/workflows/MergeAbortDialog";
import { RebaseDialog } from "@renderer/features/workflows/RebaseDialog";
import { ReplayDialog } from "@renderer/features/workflows/ReplayDialog";
import { IdentityDialog } from "@renderer/features/profiles/IdentityDialog";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useSessionStore } from "@renderer/stores/session-store";
import { emptySession } from "@shared/identity/profile-session";

it.each(["merge", "merge-start", "replay"])(
  "ignores stale %s previews after the review target changes",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const preview = (id: string) => ({
      token: id,
      path: id,
      area: "tracked" as const,
      deleted: false,
      savedBytes: id === "old-target" ? 999 : 1,
      recoveryBytes: 1,
      originalHead: id,
      bytes: 1,
      paths: [id],
      commits: [],
      kind: "revert" as const,
      action: "abort" as const,
      head: id,
      branch: "main",
      prediction: { state: "clean", paths: [], totalPaths: 0 },
      author: "Eda",
      email: "eda@example.com",
    });

    let finish!: (result: ReturnType<typeof ok<ReturnType<typeof preview>>>) => void;

    const prepare = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(ok(preview("new-target")));

    vi.stubGlobal("eda", {
      workflows: { prepareAbort: prepare, prepareStart: prepare },
      replay: { prepare },
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    const render = (id: string) => {
      const props = { repositoryId: id, onClose: vi.fn() };

      return kind === "merge-start" ? (
        <MergeStartDialog {...props} source={id} />
      ) : kind === "merge" ? (
        <MergeAbortDialog {...props} />
      ) : (
        <ReplayDialog {...props} kind="revert" action="abort" />
      );
    };

    try {
      await act(async () => root.render(render("old-target")));
      await act(async () => root.render(render("new-target")));
      const before = document.body.textContent;
      await act(async () => finish(ok(preview("old-target"))));
      expect(document.body.textContent).toBe(before);
      expect(document.body.textContent).not.toContain("old-target");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it("allows retry after profile saving rejects and retains the input", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const app = useAppStore.getState();

  const updateIdentity = vi
    .fn()
    .mockRejectedValueOnce(new Error("Transport unavailable"))
    .mockResolvedValueOnce(true);

  const onClose = vi.fn();
  useAppStore.setState({ updateIdentity, error: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <IdentityDialog
          onClose={onClose}
          identity={{
            id: "profile",
            name: "Work",
            gitName: "Eda",
            gitEmail: "eda@example.com",
            hue: 200,
            signing: { format: "none", signCommits: false },
            createdAt: "",
            updatedAt: "",
          }}
        />,
      ),
    );

    const save = () =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Save profile",
      )!;

    await act(async () => save().click());
    expect(document.body.textContent).toContain("Something went wrong. Please try again.");
    expect(save().disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    const dismiss = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Dismiss",
    )!;

    await act(async () => dismiss.click());
    await act(async () => save().click());

    expect(updateIdentity).toHaveBeenLastCalledWith(
      "profile",
      expect.objectContaining({ name: "Work", gitEmail: "eda@example.com" }),
      expect.any(Function),
    );

    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(app);
    vi.unstubAllGlobals();
  }
});

it.each(["repository", "initial commit"])(
  "resets replay selection when the %s changes",
  async (change) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const prepare = vi.fn(async () => ({
      ok: false,
      error: errorFixture({ message: "Preview unavailable" }),
    }));

    vi.stubGlobal("eda", { replay: { prepare } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(
          <ReplayDialog
            repositoryId="first"
            kind="cherry-pick"
            action="start"
            initialCommits={["old-commit"]}
            onClose={vi.fn()}
          />,
        ),
      );

      await act(async () =>
        root.render(
          <ReplayDialog
            repositoryId={change === "repository" ? "second" : "first"}
            kind="cherry-pick"
            action="start"
            {...(change === "repository"
              ? {}
              : { initialCommits: ["new-commit", "second-commit"] })}
            onClose={vi.fn()}
          />,
        ),
      );

      expect(prepare).toHaveBeenLastCalledWith(
        change === "repository" ? "second" : "first",
        "cherry-pick",
        "start",
        change === "repository" ? [] : ["new-commit", "second-commit"],
        undefined,
      );

      expect(document.body.textContent).not.toContain("old-commit");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it("invalidates a merge abort review when its workflow kind changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  let finish!: (
    result: ReturnType<
      typeof ok<{ token: string; originalHead: string; paths: string[]; bytes: number }>
    >,
  ) => void;

  const prepareAbort = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(ok({ token: "stash", originalHead: "stash-head", paths: [], bytes: 0 }));

  vi.stubGlobal("eda", { workflows: { prepareAbort } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(<MergeAbortDialog repositoryId="repo" kind="merge" onClose={vi.fn()} />),
    );

    await act(async () =>
      root.render(<MergeAbortDialog repositoryId="repo" kind="stash" onClose={vi.fn()} />),
    );

    expect(prepareAbort).toHaveBeenCalledTimes(2);

    await act(async () =>
      finish(ok({ token: "merge", originalHead: "old-merge", paths: [], bytes: 0 })),
    );

    expect(document.body.textContent).toContain("stash-head");
    expect(document.body.textContent).not.toContain("old-merge");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("preserves a rebase draft through a failed refresh and requires acceptance of a changed head", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const review = {
    head: "old",
    onto: null,
    branch: "main",
    token: "original",
    action: "amend",
    message: "Original",
    paths: [],
    publishedCommits: 0,
  };
  const prepare = vi
    .fn()
    .mockResolvedValueOnce(ok(review))
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(
      ok({ ...review, head: "new", token: "fresh", message: "Different commit" }),
    );
  const execute = vi.fn().mockResolvedValue(ok({ state: "completed" }));
  vi.stubGlobal("eda", { rebase: { prepare, execute } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((item) => item.textContent === label)!;
  try {
    await act(async () =>
      root.render(<RebaseDialog repositoryId="repo" action="amend" onClose={() => {}} />),
    );
    const message = document.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!;
    const confirm = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        message,
        "My draft",
      );
      message.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => confirm.click());
    await act(async () => button("Review current state").click());
    expect(message.value).toBe("My draft");
    expect(confirm.checked).toBe(false);
    expect(confirm.disabled).toBe(true);
    await act(async () => button("Review current state").click());
    expect(message.value).toBe("My draft");
    expect(confirm.disabled).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    await act(async () => button("Load new review").click());
    expect(message.value).toBe("Different commit");
    await act(async () => confirm.click());
    await act(async () => button("Amend paused commit").click());
    expect(execute).toHaveBeenCalledWith("repo", "fresh", undefined, "Different commit");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([0, 1])(
  "hides manual review while rewording and retains the draft on retry (%s published commits)",
  async (publishedCommits) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const preferences = usePreferencesStore.getState();
    const repository = useRepositoryStore.getState();
    const session = useSessionStore.getState();
    const execute = vi.fn().mockResolvedValue(ok({ state: "completed" }));
    const onClose = vi.fn();
    vi.stubGlobal("eda", {
      rebase: {
        prepare: vi.fn().mockResolvedValue(
          ok({
            head: "head",
            branch: "main",
            token: "review",
            action: "reword",
            message: "feat(core)!: Original\n\nDetails\n\nMore details\n",
            publishedCommits,
            rewrittenCount: 2,
          }),
        ),
        execute,
      },
    });
    useRepositoryStore.setState({ repositoryId: null });
    useSessionStore.setState({
      snapshot: {
        context: { profileId: "profile", windowId: "window", generation: 1 },
        session: emptySession(),
        recovery: null,
        drafts: { repo: { version: 1, message: "Working tree draft", amend: false } },
      },
    });
    const workingDraft = useSessionStore.getState().snapshot?.drafts["repo"];
    usePreferencesStore.setState({
      values: {
        ...preferences.values,
        conventionalCommitsEnabled: {
          ...preferences.values.conventionalCommitsEnabled,
          value: true,
        },
        commitPrefixes: { ...preferences.values.commitPrefixes, value: ["feat", "fix"] },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(
          <RebaseDialog repositoryId="repo" action="reword" onto="target" onClose={onClose} />,
        ),
      );
      const title = document.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!;
      const description = document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Commit description"]',
      )!;
      const save = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Save message",
      )!;
      const confirm = document.querySelector<HTMLInputElement>('input[type="checkbox"]');

      expect(title.value).toBe("Original");
      expect(description.value).toBe("Details\n\nMore details\n");
      expect(save.disabled).toBe(true);
      expect(document.body.textContent).not.toContain("Review current state");
      expect(document.body.textContent).toContain("Commit IDs to rewrite: 2");
      expect(!!confirm).toBe(publishedCommits > 0);

      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label="Commit prefix"]')!.click(),
      );
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-eda-select-value="fix"]')!.click(),
      );
      expect(save.disabled).toBe(publishedCommits > 0);

      if (confirm) await act(async () => confirm.click());
      expect(save.disabled).toBe(false);

      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          title,
          "Updated",
        );
        title.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(save.disabled).toBe(publishedCommits > 0);
      if (confirm) await act(async () => confirm.click());

      execute.mockResolvedValueOnce(err(errorFixture({ message: "Repository changed" })));
      await act(async () => save.click());
      expect(save.disabled).toBe(true);
      expect(title.value).toBe("Updated");

      const refresh = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Review current state",
      )!;
      await act(async () => refresh.click());
      expect(title.value).toBe("Updated");
      expect(document.body.textContent).not.toContain("Review current state");
      if (confirm) await act(async () => confirm.click());

      await act(async () => save.click());
      expect(execute).toHaveBeenCalledWith(
        "repo",
        "review",
        undefined,
        "fix(core)!: Updated\n\nDetails\n\nMore details\n",
      );
      expect(onClose).toHaveBeenCalledOnce();
      expect(useSessionStore.getState().snapshot?.drafts["repo"]).toBe(workingDraft);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      usePreferencesStore.setState(preferences);
      useRepositoryStore.setState(repository);
      useSessionStore.setState(session);
      vi.unstubAllGlobals();
    }
  },
);
