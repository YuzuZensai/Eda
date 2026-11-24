import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok } from "@shared/errors";
import type { RecoveryInspection, RecoveryPage } from "@shared/workflows/history-recovery";
import { HistoryRecoveryDialog } from "@renderer/features/workflows/HistoryRecoveryDialog";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { errorFixture } from "../../../helpers/error";
import { deferred } from "../../../helpers/deferred";

const oid = "a".repeat(40);
const page: RecoveryPage = {
  entries: [{ oid, label: "Lost work", description: "" }],
  nextOffset: null,
  cleanup: { token: "review", count: 1 },
};
const inspected: RecoveryInspection = {
  token: "inspection",
  inspection: {
    commit: {
      oid,
      subject: "Lost work",
      body: "Commit details",
      parents: [],
      decorations: [],
      author: { name: "Eda", email: "test@eda.invalid", timestamp: "2026-01-01T00:00:00Z" },
      committerTimestamp: "2026-01-01T00:00:00Z",
    },
    containingRefs: [],
    shallow: false,
    signed: false,
    signature: { status: "unsigned", format: null, reasonCode: null, diagnostics: "" },
  },
  diff: { files: [] },
};
const list = vi.fn<typeof window.eda.historyRecovery.list>();
const inspect = vi.fn<typeof window.eda.historyRecovery.inspect>();
const clearDangling = vi.fn<typeof window.eda.historyRecovery.clearDangling>();
let root: Root;
let container: HTMLDivElement;
let previous: ReturnType<typeof useRepositoryStore.getState>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { historyRecovery: { list, inspect, clearDangling } });
  previous = useRepositoryStore.getState();
  useRepositoryStore.setState({ repositoryId: null });
  list.mockResolvedValue(ok(page));
  inspect.mockResolvedValue(ok(inspected));
  clearDangling.mockResolvedValue(ok(undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useRepositoryStore.setState(previous);
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (element) => element.textContent === name || element.getAttribute("aria-label") === name,
  )!;
const open = async () => {
  await act(async () =>
    root.render(<HistoryRecoveryDialog repositoryId="repo" dangling onClose={() => {}} />),
  );
};
const clear = async () => {
  await act(async () => button("Clear 1 commit").click());
  expect(document.body.textContent).toContain("Permanently delete");
  await act(async () => button("Clear 1 commit").click());
};

it("shows a compact list, opens details on selection, and confirms cleanup in a separate step", async () => {
  await open();
  expect(list).toHaveBeenCalledWith("repo", "dangling", 0);
  expect(document.body.textContent).not.toContain("Saved recovery refs");
  expect(document.body.textContent).not.toContain("Select a commit");
  expect(document.querySelector('[aria-label="Commit ID to inspect"]')).toBeNull();
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Permanently delete");

  const entry = document.querySelector<HTMLButtonElement>(
    `[aria-label="Inspect ${oid} Lost work"]`,
  )!;
  await act(async () => entry.click());
  expect(inspect).toHaveBeenCalledWith("repo", oid);
  expect(document.body.textContent).toContain("Commit details");
  expect(document.querySelector("details")?.open).toBe(false);
  expect(document.querySelector('[aria-label="Filter recovery entries"]')).toBeNull();
  await act(async () => button("Back").click());
  expect(document.querySelector('[aria-label="Filter recovery entries"]')).not.toBeNull();

  await act(async () => button("Clear 1 commit").click());
  expect(clearDangling).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Permanently delete");
  await act(async () => button("Cancel").click());
  expect(document.body.textContent).not.toContain("Permanently delete");

  const clearing = deferred<Awaited<ReturnType<typeof window.eda.historyRecovery.clearDangling>>>();
  clearDangling.mockReturnValueOnce(clearing.promise);
  list.mockResolvedValueOnce(
    ok({ entries: [], nextOffset: null, cleanup: { token: "fresh", count: 0 } }),
  );
  await clear();
  expect(clearDangling).toHaveBeenCalledWith("repo", "review");
  expect(button("Close").disabled).toBe(true);
  expect(button("Refresh").disabled).toBe(true);
  await act(async () => clearing.resolve(ok(undefined)));
  expect(document.body.textContent).toContain("No dangling commits");
  expect(button("Clear 0 commits")).toBeUndefined();
  expect(document.querySelector("input")).toBeNull();
});

it("shows cleanup failures and requires a new confirmation after refreshing", async () => {
  await open();
  clearDangling.mockResolvedValueOnce(
    err(errorFixture({ message: "The objects changed. Refresh." })),
  );
  await clear();
  expect(document.body.textContent).toContain("The objects changed. Refresh.");
  list.mockResolvedValueOnce(ok({ ...page, cleanup: { token: "new-review", count: 1 } }));
  await act(async () => button("Refresh").click());
  expect(document.body.textContent).not.toContain("Permanently delete");
  await clear();
  expect(clearDangling).toHaveBeenLastCalledWith("repo", "new-review");
});

it("shows a retryable scan error without empty forms or a misleading zero-commit cleanup", async () => {
  list.mockResolvedValueOnce(err(errorFixture({ message: "Scan failed" })));
  await open();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Scan failed");
  expect(document.querySelector("input")).toBeNull();
  expect(button("Clear 0 commits")).toBeUndefined();
  await act(async () => button("Refresh").click());
  expect(document.querySelector(`[aria-label="Inspect ${oid} Lost work"]`)).not.toBeNull();
});

it("keeps the ordinary recovery browser on reflogs without cleanup controls", async () => {
  await act(async () =>
    root.render(<HistoryRecoveryDialog repositoryId="repo" onClose={() => {}} />),
  );
  expect(list).toHaveBeenCalledWith("repo", "reflog", 0);
  expect(document.body.textContent).toContain("Saved recovery refs");
  expect(document.body.textContent).not.toContain("Permanently delete");
  await act(async () => button("Shared-history actions").click());
  expect(document.querySelector('[role="note"]')?.textContent).toContain("force-with-lease");
});
