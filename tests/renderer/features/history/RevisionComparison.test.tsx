import { fillInput } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, type Result } from "@shared/errors";
import type {
  RevisionComparison as Comparison,
  UnifiedDiff,
} from "@shared/repository/repository-read";
import { RevisionComparison } from "@renderer/features/history/RevisionComparison";
import { deferred } from "../../../helpers/deferred";
import { errorFixture } from "../../../helpers/error";

const left = "a".repeat(40);
const right = "b".repeat(40);
const ancestor = "c".repeat(40);
const comparison: Comparison = {
  leftOid: left,
  rightOid: right,
  baseOid: left,
  omittedFiles: 0,
  files: [
    { oldPath: "before.md", newPath: "after.md", status: "renamed" },
    { oldPath: "deleted.txt", status: "deleted" },
  ],
};

let root: Root;
let container: HTMLDivElement;
const compareRevisions = vi.fn<typeof window.eda.repository.compareRevisions>();
const comparisonDiff = vi.fn<typeof window.eda.repository.comparisonDiff>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", {
    repository: {
      compareRevisions,
      comparisonDiff,
      listBranches: async () => ok([{ name: "main", isHead: true, remote: false, oid: left }]),
      listTags: async () => ok([]),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function click(name: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === name,
  );
  expect(button, name).toBeDefined();
  await act(async () => button!.click());
}

it("reads renamed and deleted files at the reviewed hashes and ignores a late file response after switching", async () => {
  const firstFile = deferred<Result<UnifiedDiff>>();
  compareRevisions.mockResolvedValue(ok(comparison));
  comparisonDiff
    .mockReturnValueOnce(firstFile.promise)
    .mockRejectedValueOnce(new Error("IPC connection lost"))
    .mockResolvedValueOnce(
      ok({ files: [{ oldPath: "deleted.txt", status: "deleted", binary: true, hunks: [] }] }),
    );

  await act(async () =>
    root.render(
      <RevisionComparison
        repositoryId="repo"
        initialLeft="main"
        initialRight="feature"
        onBack={vi.fn()}
      />,
    ),
  );
  expect(document.activeElement?.textContent).toBe("Compare revisions");
  expect(container.textContent).toContain("before.md to after.md");
  expect(comparisonDiff).toHaveBeenCalledWith({
    repositoryId: "repo",
    baseOid: left,
    rightOid: right,
    oldPath: "before.md",
    path: "after.md",
  });
  await click("View comparison for deleted.txt");
  expect(comparisonDiff).toHaveBeenLastCalledWith({
    repositoryId: "repo",
    baseOid: left,
    rightOid: right,
    path: "deleted.txt",
  });
  await act(async () => firstFile.resolve(ok({ files: [] })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load changes",
  );
  await click("Retry file diff");
  expect(container.textContent).toContain("Binary file");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
});

it("runs a new comparison when switching to the merge base and discards an older endpoint result", async () => {
  const direct = deferred<Result<Comparison>>();
  compareRevisions
    .mockReturnValueOnce(direct.promise)
    .mockResolvedValueOnce({
      ok: false,
      error: errorFixture({ message: "Temporary read failure" }),
    })
    .mockResolvedValueOnce(ok({ ...comparison, files: [], baseOid: ancestor }));
  await act(async () =>
    root.render(
      <RevisionComparison
        repositoryId="repo"
        initialLeft="main"
        initialRight="topic"
        onBack={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain("Comparing revisions");
  await click("From merge base");
  expect(compareRevisions).toHaveBeenLastCalledWith({
    repositoryId: "repo",
    left: "main",
    right: "topic",
    mode: "merge-base",
  });
  await act(async () => direct.resolve(ok(comparison)));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Temporary read failure",
  );
  await click("Retry");
  expect(container.textContent).toContain("Changes from merge base cccccccc to bbbbbbbb");
  expect(container.textContent).toContain("No changed files");
  expect(comparisonDiff).not.toHaveBeenCalled();
});

it("accepts typed revisions when the reference list is unavailable and clears the review on edit", async () => {
  vi.spyOn(window.eda.repository, "listBranches").mockRejectedValue(new Error("Read failed"));
  compareRevisions.mockResolvedValue(ok({ ...comparison, files: [] }));
  await act(async () => root.render(<RevisionComparison repositoryId="repo" onBack={vi.fn()} />));

  const from = container.querySelector<HTMLInputElement>("input")!;

  await fillInput(from, "refs/tags/release");
  await click("Compare");
  expect(compareRevisions).toHaveBeenLastCalledWith({
    repositoryId: "repo",
    left: "refs/tags/release",
    right: "HEAD",
    mode: "direct",
  });
  expect(container.textContent).toContain("No changed files");

  await fillInput(from, left);
  expect(container.textContent).not.toContain("No changed files");
  expect(container.textContent).toContain("Choose two revisions to compare");
  await click("Compare");
  expect(compareRevisions).toHaveBeenLastCalledWith({
    repositoryId: "repo",
    left,
    right: "HEAD",
    mode: "direct",
  });
});

it("shows an unsupported comparison once when the guided demo supplies methods through a proxy", async () => {
  const pending = deferred<Result<Comparison>>();
  compareRevisions
    .mockResolvedValueOnce({
      ok: false,
      error: errorFixture({ message: "Outside the guided demo" }),
    })
    .mockReturnValue(pending.promise);
  Object.defineProperty(window.eda.repository, "compareRevisions", {
    get: () => compareRevisions.bind(null),
  });
  await act(async () =>
    root.render(
      <RevisionComparison repositoryId="demo" initialLeft="a" initialRight="b" onBack={vi.fn()} />,
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Outside the guided demo",
  );
  expect(compareRevisions).toHaveBeenCalledTimes(1);
});
