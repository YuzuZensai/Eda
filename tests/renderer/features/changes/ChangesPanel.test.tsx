import { act } from "react";
import { emptySession, emptyView } from "@shared/identity/profile-session";
import { defaultFileView } from "@shared/preferences/file-view";
import { createRoot } from "react-dom/client";
import { ChangesPanel } from "@renderer/features/changes/ChangesPanel";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useSessionStore } from "@renderer/stores/session-store";

it("targets the right-clicked file, confirms discard, and dismisses menus on repository switches", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const previewDiscard = vi.fn(async () => ({
    ok: true,
    value: {
      token: "review",
      paths: ["file.txt"],
      tracked: 1,
      untracked: 0,
      bytes: 20,
    },
  }));

  const applyDiscard = vi.fn();

  vi.stubGlobal("eda", { repository: { previewDiscard, applyDiscard } });

  const previous = useRepositoryStore.getState();
  const session = useSessionStore.getState();
  const stage = vi.fn();
  const unstage = vi.fn();
  const stash = vi.fn();
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);
  const open = async () => {
    const file = container.querySelector('button[aria-label="Unstaged file.txt, status M"]')!;

    expect(file).toBeTruthy();

    await act(async () =>
      file.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
      ),
    );
  };

  const action = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) =>
      item.textContent?.includes(label),
    )!;

  try {
    useSessionStore.setState({ snapshot: null });
    useRepositoryStore.setState({
      repositoryId: "repo",
      identityId: "profile",
      writing: false,
      stage,
      unstage,
      stash,
      status: {
        branch: { ahead: 0, behind: 0, detached: false, unborn: false },
        changes: [
          { path: "file.txt", kind: "ordinary", index: ".", worktree: "M", submodule: "N..." },
        ],
      },
    });
    await act(async () => root.render(<ChangesPanel />));
    await open();
    await act(async () => action("Stage").click());
    expect(stage).toHaveBeenCalledWith(["file.txt"]);

    await open();
    await act(async () => action("Stash file").click());
    expect(stash).toHaveBeenCalledWith(["file.txt"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await open();
    await act(async () => action("Discard").click());
    expect(previewDiscard).toHaveBeenCalledWith("repo", ["file.txt"]);
    expect(applyDiscard).not.toHaveBeenCalled();

    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.textContent === "Discard selected files",
    )!;

    expect(confirm.disabled).toBe(true);

    const close = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.textContent === "Close",
    )!;

    await act(async () => close.click());
    await open();
    await act(async () => useRepositoryStore.setState({ repositoryId: "other" }));
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await act(async () => useRepositoryStore.setState({ repositoryId: "repo" }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(applyDiscard).not.toHaveBeenCalled();

    await act(async () =>
      useRepositoryStore.setState({
        status: {
          branch: { ahead: 0, behind: 0, detached: false, unborn: false },
          changes: [
            { path: "file.txt", kind: "ordinary", index: "M", worktree: ".", submodule: "N..." },
          ],
        },
      }),
    );

    const stagedFile = container.querySelector('button[aria-label="Staged file.txt, status M"]')!;

    await act(async () =>
      stagedFile.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
      ),
    );
    expect(action("Discard")).toBeUndefined();
    expect(action("Stash file").disabled).toBe(false);

    await act(async () => action("Unstage").click());
    expect(unstage).toHaveBeenCalledWith(["file.txt"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useRepositoryStore.setState(previous);
    useSessionStore.setState(session);
    vi.unstubAllGlobals();
  }
});

it.each(["path", "tree"] as const)(
  "combines tracked and untracked files under Unstaged in %s view while preserving file actions",
  async (mode) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const previewDiscard = vi.fn(async () => ({
      ok: true,
      value: {
        token: "review",
        paths: ["src/modified.txt", "src/new.txt"],
        tracked: 1,
        untracked: 1,
        bytes: 20,
      },
    }));

    vi.stubGlobal("eda", {
      sessions: { change: vi.fn(async () => ({ ok: true, value: undefined })) },
      repository: { previewDiscard },
    });

    const previous = useRepositoryStore.getState();
    const session = useSessionStore.getState();
    const stage = vi.fn();
    const unstage = vi.fn();
    const selectChange = vi.fn();
    const container = document.createElement("div");

    document.body.append(container);

    const root = createRoot(container);
    const button = (label: string) => {
      const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.getAttribute("aria-label") === label || item.textContent === label,
      );

      expect(found, label).toBeTruthy();
      return found!;
    };

    try {
      useSessionStore.setState({
        snapshot: {
          context: { profileId: "profile", windowId: "primary", generation: 1 },
          session: {
            ...emptySession(),
            views: {
              repo: {
                ...emptyView(),
                grouped: mode === "tree",
                files: { ...defaultFileView(), mode, selected: ["untracked:src/new.txt"] },
              },
            },
          },
          drafts: {},
          recovery: null,
        },
      });
      useRepositoryStore.setState({
        repositoryId: "repo",
        identityId: "profile",
        writing: false,
        selection: null,
        selectChange,
        stage,
        unstage,
        status: {
          branch: { ahead: 0, behind: 0, detached: false, unborn: false },
          changes: [
            {
              path: "src/modified.txt",
              kind: "ordinary",
              index: "M",
              worktree: "M",
              submodule: "N...",
            },
            {
              path: "src/new.txt",
              kind: "untracked",
              index: "?",
              worktree: "?",
              submodule: "N...",
            },
            {
              path: "conflict.txt",
              kind: "unmerged",
              index: "U",
              worktree: "U",
              submodule: "N...",
            },
          ],
        },
      });
      await act(async () => root.render(<ChangesPanel />));

      const headings = Array.from(container.querySelectorAll("span")).filter((item) =>
        ["Conflicts", "Staged", "Unstaged", "Untracked"].includes(item.textContent ?? ""),
      );

      expect(headings.map((item) => item.textContent)).toEqual(["Conflicts", "Staged", "Unstaged"]);
      expect(headings[2]?.parentElement?.textContent).toBe("Unstaged2Stage all");
      expect(container.querySelector('[aria-label="2 unstaged files"]')).toBeTruthy();
      expect(
        Array.from(container.querySelectorAll("button")).filter(
          (item) => item.textContent === "Stage all",
        ),
      ).toHaveLength(1);

      expect(
        button("Untracked src/new.txt, status ?").querySelector(".text-git-added svg"),
      ).toBeTruthy();

      await act(async () => button("Stage all").click());
      expect(stage).toHaveBeenLastCalledWith(["src/modified.txt", "src/new.txt"]);
      await act(async () => button("Unstage all").click());
      expect(unstage).toHaveBeenLastCalledWith(["src/modified.txt"]);

      if (mode === "tree") {
        await act(async () => button("Stage everything in src").click());
        expect(stage).toHaveBeenLastCalledWith(["src/modified.txt", "src/new.txt"]);
        await act(async () =>
          Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Collapse src"]'))
            .at(-1)!
            .click(),
        );
        expect(
          container.querySelector('[aria-label="Untracked src/new.txt, status ?"]'),
        ).toBeNull();
        expect(
          container.querySelector('[aria-label="Unstaged src/modified.txt, status M"]'),
        ).toBeNull();
        await act(async () => button("Expand src").click());
      }

      const newFile = button("Untracked src/new.txt, status ?");
      await act(async () => newFile.click());
      expect(selectChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: "src/new.txt", kind: "untracked" }),
        "untracked",
      );

      const newCheckbox = container.querySelector<HTMLInputElement>(
        '[aria-label="Select untracked src/new.txt"]',
      )!;
      const trackedCheckbox = container.querySelector<HTMLInputElement>(
        '[aria-label="Select unstaged src/modified.txt"]',
      )!;

      expect(newCheckbox.checked).toBe(true);
      await act(async () => trackedCheckbox.click());
      await act(async () => button("Stage 2 selected files").click());
      expect(stage).toHaveBeenLastCalledWith(["src/modified.txt", "src/new.txt"]);
      await act(async () =>
        newFile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
      );

      const discard = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).find((item) => item.textContent === "Discard selected changes...")!;

      expect(discard).toBeTruthy();
      await act(async () => discard.click());
      expect(previewDiscard).toHaveBeenCalledWith("repo", ["src/modified.txt", "src/new.txt"]);
      await act(async () =>
        Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
          .find((item) => item.textContent === "Close")!
          .click(),
      );

      await act(async () =>
        useSessionStore.getState().setView("repo", {
          files: { ...defaultFileView(), mode, query: "new.txt" },
        }),
      );
      expect(container.textContent).toContain("Unstaged1Stage all");
      await act(async () => button("Stage all").click());
      expect(stage).toHaveBeenLastCalledWith(["src/new.txt"]);
    } finally {
      await act(async () => root.unmount());
      await useSessionStore.getState().flush();
      container.remove();
      useRepositoryStore.setState(previous);
      useSessionStore.setState(session);
      vi.unstubAllGlobals();
    }
  },
);
