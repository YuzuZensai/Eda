import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emptySession, emptyView } from "@shared/identity/profile-session";
import { defaultGraphColumns, isGraphColumns } from "@shared/preferences/graph-view";
import { CommitGraph } from "@renderer/features/history/CommitGraph";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useSessionStore } from "@renderer/stores/session-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";

let root: Root;
let container: HTMLDivElement;
let previousSession: ReturnType<typeof useSessionStore.getState>;
let previousPreferences: ReturnType<typeof usePreferencesStore.getState>;
let previousRepository: ReturnType<typeof useRepositoryStore.getState>;
const setView = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previousSession = useSessionStore.getState();
  previousPreferences = usePreferencesStore.getState();
  previousRepository = useRepositoryStore.getState();
  setView.mockReset().mockImplementation((id, patch) => {
    const snapshot = useSessionStore.getState().snapshot!;
    useSessionStore.setState({
      snapshot: {
        ...snapshot,
        session: {
          ...snapshot.session,
          views: {
            ...snapshot.session.views,
            [id]: { ...snapshot.session.views[id], ...patch },
          },
        },
      },
    });
  });
  useSessionStore.setState({
    setView,
    transitioning: false,
    snapshot: {
      context: { profileId: "profile", windowId: "main", generation: 1 },
      session: {
        ...emptySession(),
        selectedRepositoryId: "repo",
        views: { repo: { ...emptyView(), graphColumns: defaultGraphColumns() } },
      },
      drafts: {},
      recovery: null,
    },
  });
  useRepositoryStore.setState({
    repositoryId: "repo",
    identityId: "profile",
    pages: [
      {
        commits: [
          {
            oid: "a".repeat(40),
            subject: "Sample commit",
            body: "",
            parents: [],
            decorations: [],
            author: { name: "Sample", email: "sample@example.test", timestamp: "2026-11-06" },
            committerTimestamp: "2026-11-06",
          },
        ],
        nextOffset: null,
      },
    ],
    dagBoundary: { lanes: [] },
    baseOffset: 0,
    nextOffset: null,
    selection: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CommitGraph />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSessionStore.setState(previousSession);
  useRepositoryStore.setState(previousRepository);
  usePreferencesStore.setState(previousPreferences);
  vi.unstubAllGlobals();
});

const divider = (id = "author") =>
  container.querySelector<HTMLElement>(`[role="separator"][aria-label="${id} column width"]`)!;
const authorCell = () => container.querySelector<HTMLElement>('[title="sample@example.test"]')!;
const savedColumns = () =>
  useSessionStore.getState().snapshot!.session.views["repo"]!.graphColumns!;

async function pointer(target: EventTarget, type: string, x: number, pointerId = 1) {
  if (type === "pointerdown" && target instanceof HTMLElement)
    Object.assign(target, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });

  await act(async () =>
    target.dispatchEvent(new PointerEvent(type, { clientX: x, pointerId, bubbles: true })),
  );
}

async function key(key: string, target = divider()) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

const header = (id: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="Reorder ${id} column"]`)!;
const headerOrder = () =>
  [...container.querySelectorAll<HTMLButtonElement>('[draggable="true"]')].map(
    (element) => element.textContent,
  );

async function drag(target: HTMLElement, type: string, dataTransfer = new DataTransfer()) {
  await act(async () =>
    target.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true })),
  );
  return dataTransfer;
}

it("previews a dragged boundary in the header and rows, then saves once on release", async () => {
  await pointer(divider(), "pointerdown", 200);
  await pointer(window, "pointermove", 160);
  await pointer(window, "pointermove", 152);

  expect(divider().getAttribute("aria-valuenow")).toBe("144");
  expect(authorCell().style.width).toBe("144px");
  expect(savedColumns()[0]!.width).toBe(96);
  expect(setView).not.toHaveBeenCalled();

  await pointer(window, "pointerup", 152);
  expect(setView).toHaveBeenCalledOnce();
  expect(savedColumns()[0]!.width).toBe(144);
  expect(authorCell().style.width).toBe("144px");

  await act(async () => root.render(<CommitGraph key="reopened" />));
  expect(divider().getAttribute("aria-valuenow")).toBe("144");
});

it.each(["pointercancel", "Escape", "blur"])("restores saved widths on %s", async (event) => {
  await pointer(divider(), "pointerdown", 200);
  await pointer(window, "pointermove", 120);
  expect(authorCell().style.width).toBe("176px");

  if (event === "Escape") await key("Escape");
  else await act(async () => window.dispatchEvent(new PointerEvent(event, { pointerId: 1 })));
  await pointer(window, "pointerup", 120);

  expect(authorCell().style.width).toBe("96px");
  expect(setView).not.toHaveBeenCalled();
});

it("ignores other pointers and keeps dragged widths within the saved limits", async () => {
  await pointer(divider(), "pointerdown", 200);
  await pointer(window, "pointermove", -1000, 2);
  await pointer(window, "pointerup", -1000, 2);
  expect(authorCell().style.width).toBe("96px");
  expect(setView).not.toHaveBeenCalled();

  await pointer(window, "pointermove", -1000);
  expect(authorCell().style.width).toBe("320px");
  await pointer(window, "pointermove", 1000);
  expect(authorCell().style.width).toBe("48px");
  await pointer(window, "pointerup", 1000);
  expect(savedColumns()[0]!.width).toBe(48);
});

it("resizes with the keyboard without navigating commits", async () => {
  const selectCommit = vi.spyOn(useRepositoryStore.getState(), "selectCommit").mockResolvedValue();
  await key("ArrowLeft");
  expect(savedColumns()[0]!.width).toBe(104);
  await key("ArrowRight");
  expect(savedColumns()[0]!.width).toBe(96);
  await key("End");
  expect(savedColumns()[0]!.width).toBe(320);
  await key("Home");
  expect(savedColumns()[0]!.width).toBe(48);
  expect(selectCommit).not.toHaveBeenCalled();
  selectCommit.mockRestore();
});

it.each(["profile", "repository", "pending"])(
  "cancels a drag when the %s changes",
  async (change) => {
    await pointer(divider(), "pointerdown", 200);
    await pointer(window, "pointermove", 120);

    await act(async () => {
      if (change === "profile") {
        const snapshot = useSessionStore.getState().snapshot!;
        useSessionStore.setState({
          snapshot: { ...snapshot, context: { ...snapshot.context, generation: 2 } },
        });
      } else if (change === "repository") useRepositoryStore.setState({ repositoryId: "other" });
      else root.render(<CommitGraph pending />);
    });
    await pointer(window, "pointerup", 120);
    expect(setView).not.toHaveBeenCalled();
    expect(savedColumns()[0]!.width).toBe(96);
  },
);

it("reorders headers and row cells on drop while preserving widths", async () => {
  await key("ArrowLeft", divider("sha"));
  setView.mockClear();
  const data = await drag(header("sha"), "dragstart");
  await drag(header("date"), "dragover", data);
  expect(setView).not.toHaveBeenCalled();
  await drag(header("date"), "drop", data);

  expect(setView).toHaveBeenCalledOnce();
  expect(savedColumns().map((column) => column.id)).toEqual(["author", "sha", "date"]);
  expect(savedColumns()[1]!.width).toBe(80);
  expect(headerOrder()).toEqual(["Author", "SHA", "Date"]);
  const cells = [
    ...container.querySelectorAll<HTMLElement>('[data-tour="history-commit"] span[title]'),
  ];
  expect(cells.map((cell) => cell.title)).toEqual([
    "sample@example.test",
    "a".repeat(40),
    "2026-11-06",
  ]);
  expect(cells[1]!.style.width).toBe("80px");

  await act(async () => root.render(<CommitGraph key="reopened" />));
  expect(headerOrder()).toEqual(["Author", "SHA", "Date"]);
});

it("supports keyboard reordering without moving the commit selection", async () => {
  const selectCommit = vi.spyOn(useRepositoryStore.getState(), "selectCommit").mockResolvedValue();
  await act(async () =>
    header("sha").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        altKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    ),
  );
  expect(savedColumns().map((column) => column.id)).toEqual(["author", "sha", "date"]);
  expect(selectCommit).not.toHaveBeenCalled();
  selectCommit.mockRestore();
});

it.each(["profile", "repository", "pending", "cancel"])(
  "does not save a reorder after %s changes",
  async (change) => {
    const data = await drag(header("sha"), "dragstart");
    await drag(header("date"), "dragover", data);
    await act(async () => {
      if (change === "profile") {
        const snapshot = useSessionStore.getState().snapshot!;
        useSessionStore.setState({
          snapshot: { ...snapshot, context: { ...snapshot.context, generation: 2 } },
        });
      } else if (change === "repository") useRepositoryStore.setState({ repositoryId: "other" });
      else if (change === "pending") root.render(<CommitGraph pending />);
    });
    if (change === "cancel") await drag(header("sha"), "dragend", data);
    await drag(header("date"), "drop", data);
    expect(setView).not.toHaveBeenCalled();
  },
);

it("ignores external drops and drops on the same column", async () => {
  await drag(header("date"), "drop");
  const data = await drag(header("date"), "dragstart");
  await drag(header("date"), "drop", data);
  expect(setView).not.toHaveBeenCalled();
});

it("restores metadata widths and order from layouts with a separate tags column", async () => {
  const snapshot = useSessionStore.getState().snapshot!;
  const columns = defaultGraphColumns().reverse();
  columns[0]!.width = 128;
  const legacy = [{ id: "tags", visible: true, width: 80 } as const, ...columns];
  expect(isGraphColumns(legacy)).toBe(true);
  await act(async () =>
    useSessionStore.setState({
      snapshot: {
        ...snapshot,
        session: { ...snapshot.session, views: { repo: { ...emptyView(), graphColumns: legacy } } },
      },
    }),
  );
  expect(headerOrder()).toEqual(["SHA", "Date", "Author"]);
  expect(divider("sha").getAttribute("aria-valuenow")).toBe("128");
  await key("ArrowLeft");
  expect(savedColumns().map((column) => column.id)).toEqual(["sha", "date", "author"]);
});

it("follows global column visibility across repositories and ignores legacy visibility flags", async () => {
  const snapshot = useSessionStore.getState().snapshot!;
  const oldColumns = defaultGraphColumns().map((column) => ({ ...column, visible: false }));
  await act(async () => {
    useSessionStore.setState({
      snapshot: {
        ...snapshot,
        session: {
          ...snapshot.session,
          views: { repo: { ...emptyView(), graphColumns: oldColumns }, other: emptyView() },
        },
      },
    });
    usePreferencesStore.setState({
      values: {
        ...previousPreferences.values,
        historyVisibleColumns: {
          ...previousPreferences.values.historyVisibleColumns,
          value: ["sha"],
        },
      },
    });
  });
  expect(headerOrder()).toEqual(["SHA"]);
  expect(authorCell()).toBeNull();
  expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();

  await act(async () => useRepositoryStore.setState({ repositoryId: "other" }));
  expect(headerOrder()).toEqual(["SHA"]);
  await act(async () =>
    usePreferencesStore.setState({
      values: {
        ...previousPreferences.values,
        historyVisibleColumns: { ...previousPreferences.values.historyVisibleColumns, value: [] },
      },
    }),
  );
  expect(headerOrder()).toEqual([]);
  expect(container.textContent).toContain("Sample commit");
  expect(setView).not.toHaveBeenCalled();
});
