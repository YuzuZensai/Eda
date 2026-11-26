import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok, type Result } from "@shared/errors";
import type {
  CommitSignatureVerification,
  HistoryCommit,
} from "@shared/repository/repository-read";
import { CommitRow } from "@renderer/features/history/CommitRow";
import { CommitGraph } from "@renderer/features/history/CommitGraph";
import { ReferenceRow } from "@renderer/features/references/ReferenceRow";
import {
  firstParentPaths,
  layoutCommitPage,
  layoutCommitPages,
} from "@renderer/repository/dag-layout";
import { cacheCommitSignature } from "@renderer/repository/hooks/useCommitSignature";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useAppStore } from "@renderer/stores/app-store";
import { errorFixture } from "../../../helpers/error";

const commit: HistoryCommit = {
  oid: "a".repeat(40),
  subject: "Example commit",
  body: "",
  parents: [],
  decorations: [],
  author: { name: "Sample", email: "sample@example.test", timestamp: "2026-11-06T12:00:00Z" },
  committerTimestamp: "2026-11-06T12:00:00Z",
};

const signature = (status: CommitSignatureVerification["status"]): CommitSignatureVerification => ({
  status,
  format: status === "unsigned" ? null : "ssh",
  reasonCode: status === "invalid" ? "bad-signature" : null,
  diagnostics: "",
});

let root: Root;
let container: HTMLDivElement;
let generation = 0;
let repositoryId: string;
let previous: ReturnType<typeof useRepositoryStore.getState>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previous = useRepositoryStore.getState();
  repositoryId = `repo-${++generation}`;
  useRepositoryStore.setState({
    repositoryId,
    identityId: "work",
    generation,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useRepositoryStore.setState(previous);
  container.remove();
  vi.unstubAllGlobals();
});

function row(vigilantMode: boolean, oid = commit.oid, showSha = true) {
  return (
    <CommitRow
      row={layoutCommitPage([{ ...commit, oid }]).rows[0]!}
      columns={[{ id: "sha", visible: showSha, width: 72 }]}
      gutter={40}
      selected={false}
      related={false}
      vigilantMode={vigilantMode}
      onSelect={vi.fn()}
      onContextMenu={vi.fn()}
    />
  );
}

it("keeps the checkout marker on HEAD while browsing and keeps synchronized branch labels together after detaching", async () => {
  const other = { ...commit, oid: "b".repeat(40), subject: "Other commit" };
  const tip: HistoryCommit = {
    ...commit,
    decorations: [
      { type: "head", name: "main", target: "refs/heads/main" },
      { type: "remote-branch", name: "origin/main" },
      { type: "remote-branch", name: "fork/main" },
    ],
  };
  const branch = {
    oid: tip.oid,
    head: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    detached: false,
    unborn: false,
  };
  vi.stubGlobal("eda", {
    repository: {
      worktrees: async () => ok([]),
      listBranches: async () =>
        ok([{ name: "main", upstream: "origin/main", oid: tip.oid, remote: false, isHead: true }]),
    },
  });
  useRepositoryStore.setState({
    pages: [{ commits: [tip, other], nextOffset: null }],
    status: { branch, changes: [] },
    baseOffset: 0,
    nextOffset: null,
    selection: { kind: "commit", oid: other.oid },
  });
  await act(async () => root.render(<CommitGraph />));
  const rows = () => container.querySelectorAll<HTMLElement>('[data-tour="history-commit"]');
  const marker = "Checked out in this worktree";
  expect(rows()[0]?.getAttribute("aria-description")).toContain(marker);
  expect(rows()[1]?.getAttribute("aria-description")).not.toContain(marker);
  expect(rows()[1]?.getAttribute("aria-pressed")).toBe("true");
  expect(rows()[0]?.querySelector('[title="main · origin/main"]')?.textContent).toBe(
    "main · origin",
  );
  expect(rows()[0]?.querySelector('[title="fork/main"]')).not.toBeNull();

  await act(async () =>
    useRepositoryStore.setState({
      pages: [
        {
          commits: [
            {
              ...tip,
              decorations: [{ type: "local-branch", name: "main" }, ...tip.decorations.slice(1)],
            },
            { ...other, decorations: [{ type: "ref", name: "HEAD" }] },
          ],
          nextOffset: null,
        },
      ],
      status: {
        branch: { oid: other.oid, detached: true, unborn: false, ahead: 0, behind: 0 },
        changes: [],
      },
    }),
  );
  expect(rows()[0]?.getAttribute("aria-description")).not.toContain(marker);
  expect(rows()[1]?.getAttribute("aria-description")).toContain(marker);
  expect(rows()[0]?.querySelector('[title="main · origin/main"]')?.textContent).toBe(
    "main · origin",
  );

  await act(async () =>
    useRepositoryStore.setState({
      pages: [
        {
          commits: [
            { ...tip, decorations: [{ type: "local-branch", name: "main" }] },
            { ...other, decorations: [{ type: "remote-branch", name: "origin/main" }] },
          ],
          nextOffset: null,
        },
      ],
    }),
  );
  expect(rows()[0]?.querySelector('[title="main"]')?.textContent).toBe("main");
  expect(rows()[1]?.querySelector('[title="origin/main"]')?.textContent).toBe("origin/main");
});

it("highlights only the branch tip when hovering its reference row", async () => {
  const parent = { ...commit, oid: "b".repeat(40), subject: "Parent commit" };
  const tip = { ...commit, subject: "Branch tip", parents: [parent.oid] };

  useRepositoryStore.setState({
    pages: [{ commits: [tip, parent], nextOffset: null }],
    dagBoundary: { lanes: [] },
    hoveredRefOid: null,
    baseOffset: 0,
    nextOffset: null,
    selection: null,
  });

  await act(async () =>
    root.render(
      <>
        <ReferenceRow
          item={{ name: "feature", oid: tip.oid, isHead: false, remote: false }}
          selected={false}
          onActions={vi.fn()}
          onCheckout={vi.fn()}
        />
        <CommitGraph />
      </>,
    ),
  );

  const reference = container.querySelector('[aria-label="Inspect branch feature"]')!;
  const rows = container.querySelectorAll<HTMLElement>('[data-tour="history-commit"]');
  expect(rows).toHaveLength(2);

  await act(async () => reference.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));

  expect(rows[0]!.classList.contains("bg-accent-muted")).toBe(true);
  expect(rows[1]!.classList.contains("bg-accent-muted")).toBe(false);

  await act(async () => reference.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));

  expect(rows[0]!.classList.contains("bg-accent-muted")).toBe(false);
});

it("dims inactive merge edges and circles with opaque colors", async () => {
  const main = { ...commit, oid: "b".repeat(40) };
  const side = { ...commit, oid: "c".repeat(40) };
  const merge = { ...commit, parents: [main.oid, side.oid] };
  const { rows } = layoutCommitPage([merge, main, side]);

  const renderMerge = (...tips: string[]) =>
    act(async () =>
      root.render(
        <CommitRow
          row={rows[0]!}
          columns={[]}
          gutter={60}
          selected={false}
          related={false}
          graphEmphasis={firstParentPaths(rows, tips)}
          onSelect={vi.fn()}
          onContextMenu={vi.fn()}
        />,
      ),
    );

  await renderMerge(merge.oid);
  const [mainEdge, sideEdge] = container.querySelectorAll("svg > path");
  expect(sideEdge?.getAttribute("opacity")).toBeNull();
  expect(sideEdge?.getAttribute("stroke")).toContain("var(--bg-base)");
  expect(mainEdge?.getAttribute("stroke")).toBe("currentColor");

  await renderMerge(merge.oid, side.oid);
  expect(sideEdge?.getAttribute("stroke")).toBe("currentColor");

  await renderMerge(side.oid);
  const node = container.querySelector("svg > circle")!;
  expect(node.getAttribute("opacity")).toBeNull();
  expect(node.getAttribute("fill")).toContain("var(--bg-base)");
  expect(node.getAttribute("stroke")).toBe(node.getAttribute("fill"));
});

it("keeps a side lane dim across intervening rows until the active branch joins it", async () => {
  const history = (oid: string, ...parents: string[]) => ({
    ...commit,
    oid,
    subject: oid,
    parents,
  });
  const rows = layoutCommitPages([
    [history("active", "next"), history("side", "base")],
    [history("unrelated"), history("next", "base"), history("base")],
  ]);
  const renderHistory = (...tips: string[]) =>
    act(async () => {
      const emphasis = firstParentPaths(rows, tips);
      root.render(
        rows.map((row) => (
          <CommitRow
            key={row.commit.oid}
            row={row}
            columns={[]}
            gutter={60}
            selected={false}
            related={false}
            graphEmphasis={emphasis}
            onSelect={vi.fn()}
            onContextMenu={vi.fn()}
          />
        )),
      );
    });

  await renderHistory("active");
  const sideStroke = (subject: string) => {
    const paths = container.querySelectorAll<SVGPathElement>(
      `[aria-label^="${subject}."] svg > path`,
    );
    return Array.from(paths)
      .find((path) => path.style.color === "var(--graph-lane-1)")
      ?.getAttribute("stroke");
  };

  const inactive = sideStroke("side");
  expect(inactive).toContain("var(--bg-base)");
  expect(sideStroke("unrelated")).toBe(inactive);
  expect(sideStroke("next")).toBe(inactive);
  expect(sideStroke("base")).toBe("currentColor");

  await renderHistory("active", "side");
  expect(sideStroke("unrelated")).toBe("currentColor");
});

it.each([
  ["verified", "Verified signature", "text-git-added"],
  ["invalid", "Invalid signature", "text-git-deleted"],
  ["unverified", "Signature could not be verified", "text-git-modified"],
  ["unsigned", "Unsigned", "text-git-modified"],
] as const)(
  "shows %s signing status beside the SHA only in vigilant mode",
  async (status, label, tone) => {
    const commitSignature = vi.fn(async () => ok(signature(status)));
    vi.stubGlobal("eda", { repository: { commitSignature } });

    await act(async () => root.render(row(false)));
    expect(commitSignature).not.toHaveBeenCalled();
    expect(container.querySelector('[role="img"]')).toBeNull();

    await act(async () => root.render(row(true, commit.oid, false)));
    expect(commitSignature).not.toHaveBeenCalled();

    await act(async () => root.render(row(true)));
    const icon = container.querySelector<HTMLElement>('[role="img"]')!;
    expect(icon.getAttribute("aria-label")).toBe(label);
    expect(icon.className).toContain(tone);
    expect(icon.parentElement?.textContent).toBe(commit.oid.slice(0, 7));
    expect(icon.hasAttribute("tabindex")).toBe(false);
    expect(commitSignature).toHaveBeenCalledWith(repositoryId, commit.oid);

    await act(async () => root.render(row(false)));
    expect(container.querySelector('[role="img"]')).toBeNull();
    await act(async () => root.render(row(true)));
    expect(commitSignature).toHaveBeenCalledOnce();
  },
);

it("ignores old profile responses and keeps a rechecked signature newer than pending background work", async () => {
  const pending: Array<(value: Result<CommitSignatureVerification>) => void> = [];
  const commitSignature = vi.fn(
    () => new Promise<Result<CommitSignatureVerification>>((resolve) => pending.push(resolve)),
  );
  vi.stubGlobal("eda", { repository: { commitSignature } });

  await act(async () => root.render(row(true)));
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Checking signature",
  );
  expect(container.querySelector('[role="img"] .animate-spin-fast')).toBeNull();

  await act(async () => useRepositoryStore.setState({ identityId: "home" }));
  await act(async () => pending[0]!(ok(signature("verified"))));
  expect(container.querySelector('[aria-label="Verified signature"]')).toBeNull();

  await act(async () =>
    cacheCommitSignature(repositoryId, "home", commit.oid, signature("invalid")),
  );
  await act(async () => pending[1]!(ok(signature("verified"))));
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Invalid signature",
  );

  await act(async () => useRepositoryStore.setState({ generation: ++generation }));
  expect(container.querySelector('[aria-label="Invalid signature"]')).not.toBeNull();
  expect(commitSignature).toHaveBeenCalledTimes(2);

  await act(async () => root.render(row(true, "b".repeat(40))));
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Checking signature",
  );
  await act(async () => pending[2]!(err(errorFixture({ message: "Commit unavailable" }))));
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Signature could not be verified",
  );
});

it("limits background verification and drops queued rows when vigilant mode is disabled", async () => {
  const pending: Array<(value: Result<CommitSignatureVerification>) => void> = [];
  const commitSignature = vi.fn(
    () => new Promise<Result<CommitSignatureVerification>>((resolve) => pending.push(resolve)),
  );
  vi.stubGlobal("eda", { repository: { commitSignature } });

  await act(async () =>
    root.render(
      <>
        {row(true)}
        {row(true, "b".repeat(40))}
        {row(true, "c".repeat(40))}
      </>,
    ),
  );
  expect(commitSignature).toHaveBeenCalledTimes(2);

  await act(async () => root.render(row(false)));
  await act(async () => pending.forEach((resolve) => resolve(ok(signature("unsigned")))));
  expect(commitSignature).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="img"]')).toBeNull();
});

it("reuses verified statuses when repository history refreshes", async () => {
  const commitSignature = vi.fn(async () => ok(signature("verified")));
  vi.stubGlobal("eda", { repository: { commitSignature } });
  await act(async () => root.render(row(true)));

  await act(async () => useRepositoryStore.setState({ generation: ++generation }));
  expect(container.querySelector('[aria-label="Verified signature"]')).not.toBeNull();
  expect(commitSignature).toHaveBeenCalledOnce();
});

it("keeps the signature status visible during a timed refresh and after scrolling back", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const pending: Array<(value: Result<CommitSignatureVerification>) => void> = [];
  const commitSignature = vi.fn(
    () => new Promise<Result<CommitSignatureVerification>>((resolve) => pending.push(resolve)),
  );
  vi.stubGlobal("eda", { repository: { commitSignature } });

  try {
    await act(async () => root.render(row(true)));
    await act(async () => pending[0]!(ok(signature("verified"))));
    const iconLabel = () => container.querySelector('[role="img"]')?.getAttribute("aria-label");
    expect(iconLabel()).toBe("Verified signature");

    await act(async () => vi.advanceTimersByTime(60_000));
    expect(commitSignature).toHaveBeenCalledTimes(2);
    expect(iconLabel()).toBe("Verified signature");

    await act(async () => root.render(null));
    await act(async () => root.render(row(true)));
    expect(iconLabel()).toBe("Verified signature");
    expect(commitSignature).toHaveBeenCalledTimes(2);

    await act(async () => pending[1]!(ok(signature("invalid"))));
    expect(iconLabel()).toBe("Invalid signature");
  } finally {
    await act(async () => root.render(null));
    await act(async () => pending.forEach((resolve) => resolve(ok(signature("unsigned")))));
    visibility.mockRestore();
    vi.useRealTimers();
  }
});

it("keeps the unavailable status visible while retrying a row shown again", async () => {
  let finishRetry: ((value: Result<CommitSignatureVerification>) => void) | undefined;
  const commitSignature = vi
    .fn()
    .mockResolvedValueOnce(err(errorFixture({ message: "Temporarily unavailable" })))
    .mockImplementationOnce(
      () => new Promise<Result<CommitSignatureVerification>>((resolve) => (finishRetry = resolve)),
    );
  vi.stubGlobal("eda", { repository: { commitSignature } });
  await act(async () => root.render(row(true)));
  expect(container.querySelector('[aria-label="Signature could not be verified"]')).not.toBeNull();

  await act(async () => root.render(row(false)));
  await act(async () => root.render(row(true)));
  const label = container.querySelector('[role="img"]')?.getAttribute("aria-label");
  await act(async () => finishRetry!(ok(signature("verified"))));
  expect(label).toBe("Signature could not be verified");
  expect(container.querySelector('[aria-label="Verified signature"]')).not.toBeNull();
});

it("drops removed membership entries and queued work without retaining late results", async () => {
  const app = useAppStore.getState();
  const pending: Array<(value: Result<CommitSignatureVerification>) => void> = [];
  const commitSignature = vi.fn(
    () => new Promise<Result<CommitSignatureVerification>>((resolve) => pending.push(resolve)),
  );
  vi.stubGlobal("eda", { repository: { commitSignature } });
  useAppStore.setState({
    activeIdentity: {
      id: "work",
      name: "Work",
      gitName: "Work",
      gitEmail: "work@example.test",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "now",
      updatedAt: "now",
    },
    switchingIdentityId: null,
    repositories: [
      {
        id: repositoryId,
        identityId: "work",
        name: "Repository",
        path: "/repo",
        favourite: false,
        available: true,
      },
    ],
  });

  try {
    await act(async () =>
      root.render(
        <>
          {row(true)}
          {row(true, "b".repeat(40))}
          {row(true, "c".repeat(40))}
        </>,
      ),
    );
    expect(commitSignature).toHaveBeenCalledTimes(2);
    await act(async () => useAppStore.setState({ repositories: [] }));
    await act(async () => pending.forEach((resolve) => resolve(ok(signature("verified")))));
    expect(commitSignature).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="Verified signature"]')).toBeNull();

    await act(async () => root.render(row(false)));
    await act(async () => root.render(row(true)));
    expect(commitSignature).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[aria-label="Checking signature"]')).not.toBeNull();
    await act(async () => pending[2]!(err(errorFixture({ message: "Repository removed" }))));
  } finally {
    useAppStore.setState(app);
  }
});
