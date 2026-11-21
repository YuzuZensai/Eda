import { act } from "react";
import { createRoot } from "react-dom/client";
import { ok } from "@shared/errors";
import { deferred } from "../../../helpers/deferred";
import { DiscardDialog } from "@renderer/features/changes/DiscardDialog";

it("shows the recovery empty state only after a successful read and retries a failed read in place", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pending = deferred<void>();
  const listRecovery = vi
    .fn()
    .mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("Disconnected");
    })
    .mockResolvedValueOnce(ok([]));
  vi.stubGlobal("eda", { repository: { listRecovery } });
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(<DiscardDialog repositoryId="repo" paths={null} onClose={() => {}} />),
    );
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Reading file recovery data",
    );
    expect(document.body.textContent).not.toContain("No saved recovery snapshots");
    await act(async () => pending.resolve());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not read");
    expect(document.body.textContent).not.toContain("No saved recovery snapshots");
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("No saved recovery snapshots");
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
