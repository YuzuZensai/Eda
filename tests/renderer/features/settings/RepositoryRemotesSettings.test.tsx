import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, type Result } from "@shared/errors";
import type { RemoteState } from "@shared/integrations/remotes";
import { RepositoryRemotesSettings } from "@renderer/features/settings/repository/RepositoryRemotesSettings";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps remote editing disabled during loading and offers retry after inspection fails", async () => {
  let finish!: (value: Result<RemoteState>) => void;
  const inspect = vi.fn(
    () =>
      new Promise<Result<RemoteState>>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("eda", { remotes: { inspect } });
  await act(async () => root.render(<RepositoryRemotesSettings repositoryId="repo" />));

  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(container.textContent).not.toContain("No upstream configured");
  expect(
    [...container.querySelectorAll("button, input")].every((control) =>
      control.hasAttribute("disabled"),
    ),
  ).toBe(true);

  inspect.mockRejectedValueOnce(new Error("transport closed"));
  await act(async () => root.render(<RepositoryRemotesSettings repositoryId="other" />));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  expect(retry.disabled).toBe(false);
  expect([...container.querySelectorAll("input")].every((input) => input.disabled)).toBe(true);

  await act(async () => retry.click());
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  await act(async () =>
    finish(
      ok({
        remotes: [{ name: "origin", fetchUrls: ["https://example.com/repo.git"], pushUrls: [] }],
        branches: [
          { name: "main", oid: "a".repeat(40), remote: false, isHead: true, upstreamState: "" },
        ],
      }),
    ),
  );

  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(container.textContent).toContain("https://example.com/repo.git");
  expect([...container.querySelectorAll("input")].every((input) => !input.disabled)).toBe(true);
});
