import { err, ok } from "@shared/errors";
import { UndoRedoDialog } from "@renderer/features/workflows/UndoRedoDialog";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { errorFixture } from "../../../helpers/error";

it("removes outdated reversal choices after a failed refresh and restores them on retry", async () => {
  const reversals = vi.fn<typeof window.eda.historyRecovery.reversals>().mockResolvedValue(
    ok([
      {
        kind: "commit",
        direction: "undo",
        label: "Undo initial commit",
        id: "commit",
        fromHead: "abcd",
        toHead: "",
        available: true,
        publishedCommits: 0,
      },
    ]),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { historyRecovery: { reversals } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<UndoRedoDialog repositoryId="repo" onClose={() => {}} />));
    expect(document.body.textContent).toContain("Undo initial commit");
    reversals.mockResolvedValueOnce(err(errorFixture({ message: "History unavailable" })));
    const refresh = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh actions"]',
    )!;
    await act(async () => refresh.click());
    expect(document.body.textContent).toContain("History unavailable");
    expect(document.body.textContent).not.toContain("Undo initial commit");
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    await act(async () => refresh.click());
    expect(document.body.textContent).toContain("Undo initial commit");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
