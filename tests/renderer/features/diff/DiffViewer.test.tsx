import { deferred } from "../../../helpers/deferred";
import { errorFixture } from "../../../helpers/error";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ok, type Result } from "@shared/errors";
import type { DiscardPreview } from "@shared/workflows/recovery";
import type { UnifiedDiff } from "@shared/repository/repository-read";
import { useAppStore } from "@renderer/stores/app-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { DiffViewer } from "@renderer/features/diff/DiffViewer";
import { SplitDiffRow } from "@renderer/features/diff/DiffRows";
import type { ImagePreview } from "@shared/repository/image-preview";

it("emphasizes changed words and highlights literal search matches on the visible split row", () => {
  const row = {
    key: "pair",
    left: { key: "before", kind: "deletion", text: "const old = 1" },
    right: { key: "after", kind: "addition", text: "const next = 1" },
  } as const;
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <SplitDiffRow row={row} active wrap={false} query="NEXT =" />,
  );
  expect(
    [...container.querySelectorAll("[data-diff-text] .bg-accent-muted")].map(
      (part) => part.textContent,
    ),
  ).toEqual(["old", "next"]);
  expect(
    [...container.querySelectorAll("mark[data-active-search-match]")]
      .map((part) => part.textContent)
      .join(""),
  ).toBe("next =");
});

it("keeps a partial-discard review through a diff refresh and closes it when the selected file changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  let finish!: (value: Result<DiscardPreview>) => void;
  const pending = new Promise<Result<DiscardPreview>>((resolve) => {
    finish = resolve;
  });
  const previewDiscardPartial = vi.fn(() => pending);

  vi.stubGlobal("eda", { repository: { previewDiscardPartial } });

  const app = useAppStore.getState();
  const repository = useRepositoryStore.getState();
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);
  const diff: UnifiedDiff = {
    sourceDigest: "a".repeat(64),
    files: [
      {
        oldPath: "file.txt",
        newPath: "file.txt",
        status: "modified",
        binary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            heading: "",
            lines: [
              { type: "deletion", content: "before", oldLineNumber: 1 },
              { type: "addition", content: "after", newLineNumber: 1 },
            ],
          },
        ],
      },
    ],
  };

  try {
    useAppStore.setState({ activeIdentity: null, selectedRepositoryId: "repository" });
    useRepositoryStore.setState({
      repositoryId: "repository",
      identityId: "profile",
      selection: { kind: "change", path: "file.txt", area: "unstaged" },
      writing: false,
      diffLoading: false,
      diff,
      error: null,
    });
    await act(async () => root.render(<DiffViewer pending />));
    expect(container.querySelector("h3")?.textContent).toBe("Diff viewer");
    expect(container.querySelector('[role="status"][aria-label="Loading diff"]')).not.toBeNull();
    expect(container.textContent).not.toContain("file.txt");
    expect(container.querySelector('[aria-label="Collapse diff viewer"]')).not.toBeNull();

    await act(async () => root.render(<DiffViewer />));

    const header = container.querySelector("header");
    const line = container.querySelector<HTMLInputElement>('[aria-label="Select added line 1"]');

    expect(line).not.toBeNull();

    await act(async () => line!.click());
    expect(line!.checked).toBe(true);

    const discard = container.querySelector<HTMLButtonElement>('[aria-label="Discard hunk 1"]');

    expect(discard).not.toBeNull();

    await act(async () => discard!.click());
    expect(previewDiscardPartial).toHaveBeenCalledWith({
      sourceDigest: diff.sourceDigest,
      repositoryId: "repository",
      path: "file.txt",
      area: "unstaged",
      hunks: [0],
    });

    await act(async () => {
      useRepositoryStore.setState({
        selection: { kind: "change", path: "file.txt", area: "unstaged" },
        diff: null,
        diffLoading: true,
      });
      finish(
        ok({
          token: "review",
          paths: ["file.txt"],
          tracked: 1,
          untracked: 0,
          bytes: 5,
          patch: "reviewed changes",
        }),
      );
    });
    expect(container.querySelector("header")).toBe(header);
    expect(container.querySelector('[role="status"][aria-label="Loading diff"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"] pre')?.textContent).toBe("reviewed changes");

    await act(async () => useRepositoryStore.setState({ diff, diffLoading: false }));
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Select added line 1"]')?.checked,
    ).toBe(false);
    expect(document.querySelector('[role="dialog"] pre')?.textContent).toBe("reviewed changes");

    await act(async () =>
      useRepositoryStore.setState({
        selection: { kind: "change", path: "another.txt", area: "unstaged" },
      }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState(app);
    useRepositoryStore.setState(repository);
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps the rendered file and header in place until the requested diff is ready", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { repository: {} });
  const previous = useRepositoryStore.getState();
  const container = document.createElement("div");
  const root = createRoot(container);
  const select = (path: string) =>
    useRepositoryStore.setState({
      selection: { kind: "change", area: "unstaged", path },
      diff: null,
      diffLoading: true,
      error: null,
    });
  const finish = (path: string) =>
    useRepositoryStore.setState({
      diff: { files: [{ newPath: path, status: "modified", binary: false, hunks: [] }] },
      diffLoading: false,
    });
  const skeleton = () => container.querySelector('[aria-label="Loading diff"] .ui-skeleton');
  try {
    await act(async () => {
      select("fast.txt");
      root.render(<DiffViewer />);
    });
    expect(skeleton()).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(skeleton()).not.toBeNull();
    await act(async () => finish("fast.txt"));
    const header = container.querySelector("header");
    const rows = container.querySelector("[data-virtual-list]");
    expect(rows?.textContent).toContain("fast.txt");

    await act(async () => select("slow.txt"));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(container.querySelector("[data-virtual-list]")).toBe(rows);
    expect(header?.textContent).toContain("fast.txt");
    expect(rows?.closest("[inert]")).not.toBeNull();
    expect(skeleton()).toBeNull();

    await act(async () => select("latest.txt"));
    expect(container.querySelector("[data-virtual-list]")).toBe(rows);
    await act(async () => finish("latest.txt"));
    expect(container.querySelector("header")).toBe(header);
    expect(header?.textContent).toContain("latest.txt");
    expect(container.querySelector("[data-virtual-list]")?.textContent).toContain("latest.txt");
    expect(container.querySelector("[data-virtual-list]")?.closest("[inert]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useRepositoryStore.setState(previous, true);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("rejects stale image responses after file switches and retains a retry after a preview failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const decoded = deferred<void>();
  vi.stubGlobal(
    "Image",
    class {
      decode = () => decoded.promise;
    },
  );
  const requests: ((result: Result<ImagePreview>) => void)[] = [];
  const imagePreview = vi.fn(
    () => new Promise<Result<ImagePreview>>((finish) => requests.push(finish)),
  );
  vi.stubGlobal("eda", { repository: { imagePreview } });
  const initial = useRepositoryStore.getState();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const diff = (path: string): UnifiedDiff => ({
    files: [{ newPath: path, status: "added", binary: true, hunks: [] }],
  });
  const first = diff("first.png");
  const second = diff("second.png");
  const preview = (path: string): ImagePreview => ({
    before: { kind: "missing", path },
    after: {
      kind: "image",
      path,
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${path}`,
      bytes: 20,
    },
  });
  try {
    await act(async () => {
      useRepositoryStore.setState({
        repositoryId: "repo",
        identityId: "profile",
        generation: 1,
        diff: first,
        selection: { kind: "change", area: "unstaged", path: "first.png" },
      });
      root.render(<DiffViewer />);
    });
    await act(async () => {
      useRepositoryStore.setState({
        selection: { kind: "change", area: "unstaged", path: "second.png" },
        diff: second,
      });
    });
    await act(async () => requests[0]!(ok(preview("first.png"))));
    expect(container.querySelector("img")).toBeNull();
    await act(async () =>
      requests[1]!({
        ok: false,
        error: errorFixture({
          kind: "unknown",
          operation: "image preview",
          message: "Image read failed",
        }),
      }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Image read failed");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const retry = () =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry image preview",
      );
    imagePreview.mockRejectedValueOnce(new Error("Transport disconnected"));
    await act(async () => retry()!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load image",
    );
    await act(async () => retry()!.click());
    await act(async () => requests[2]!(ok(preview("second.png"))));
    expect(container.querySelector("img")).toBeNull();
    await act(async () => decoded.resolve());
    expect(container.querySelector("img")?.getAttribute("alt")).toBe(
      "Working tree image: second.png",
    );
    await act(async () =>
      useRepositoryStore.setState({ identityId: "other-profile", generation: 2 }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[aria-label="Loading image preview"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    useRepositoryStore.setState(initial);
    container.remove();
    vi.unstubAllGlobals();
  }
});
