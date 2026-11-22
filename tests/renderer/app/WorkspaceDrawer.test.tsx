import { TransferProgress } from "@renderer/features/sync/TransportFields";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok } from "@shared/errors";
import type { OperationRecord } from "@shared/operations";
import { WorkspaceDrawer } from "@renderer/app/WorkspaceDrawer";
import { useAppStore } from "@renderer/stores/app-store";

let root: Root;
let container: HTMLDivElement;
let changed: () => void;
const list = vi.fn();

const record: OperationRecord = {
  id: "pull",
  profileId: "profile",
  repositoryId: "repo",
  repositoryName: "Eda",
  kind: "Pull",
  state: "running",
  startedAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
  durationMs: 0,
  output: "",
  message: "save local changes for pull",
  cancellable: true,
  retryable: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useAppStore.setState({ selectedRepositoryId: "repo", repositories: [] });
  list.mockReset().mockResolvedValue(ok([record]));

  vi.stubGlobal("eda", {
    operations: { list },
    events: {
      onOperationsChanged: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const progress = () => container.querySelector('[role="status"]');

const update = async () =>
  act(async () => {
    changed();
    await vi.advanceTimersByTimeAsync(100);
  });

it("shows current progress while collapsed, updates it, and clears it when finished", async () => {
  await act(async () => root.render(<WorkspaceDrawer />));
  expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(progress()?.textContent).toContain("Eda, save local changes for pull");
  list.mockResolvedValue(ok([{ ...record, message: "apply stash" }]));
  await update();
  expect(progress()?.textContent).toContain("Eda, apply stash");

  for (const state of ["succeeded", "failed", "interrupted"] as const) {
    list.mockResolvedValue(ok([{ ...record, state, cancellable: false }]));
    await update();
    expect(progress()).toBeNull();
    expect(container.textContent).toContain(state);
  }
});

it("prioritizes progress for the selected repository when multiple operations are running", async () => {
  list.mockResolvedValue(
    ok([{ ...record, id: "other", repositoryId: "other", repositoryName: "Other" }, record]),
  );

  await act(async () => root.render(<WorkspaceDrawer />));
  expect(progress()?.textContent).toContain("2 running");
  expect(progress()?.textContent).toContain("Eda, save local changes for pull");
  await act(async () => useAppStore.setState({ selectedRepositoryId: "other" }));
  expect(progress()?.textContent).toContain("Other, save local changes for pull");
});

it("does not overwrite fresh progress with a slower previous request", async () => {
  let finish!: (value: ReturnType<typeof ok>) => void;

  list.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await act(async () => root.render(<WorkspaceDrawer />));
  list.mockResolvedValue(ok([{ ...record, message: "apply stash" }]));
  await update();
  await act(async () => finish(ok([record])));
  expect(progress()?.textContent).toContain("Eda, apply stash");
});

it("shares progress loading with transfer dialogs and releases the last subscription", async () => {
  const unsubscribe = vi.fn();
  const subscribe = vi.spyOn(window.eda.events, "onOperationsChanged").mockReturnValue(unsubscribe);

  await act(async () =>
    root.render(
      <>
        <WorkspaceDrawer />
        <TransferProgress repositoryId="repo" kindKey="operationTitles.pushBranch" />
      </>,
    ),
  );

  expect(list).toHaveBeenCalledTimes(1);
  expect(subscribe).toHaveBeenCalledTimes(1);

  await act(async () => root.render(<WorkspaceDrawer />));
  expect(unsubscribe).not.toHaveBeenCalled();

  await act(async () => root.render(null));
  expect(unsubscribe).toHaveBeenCalledTimes(1);

  await act(async () => root.render(<WorkspaceDrawer />));
  expect(list).toHaveBeenCalledTimes(2);
  expect(subscribe).toHaveBeenCalledTimes(2);
});
