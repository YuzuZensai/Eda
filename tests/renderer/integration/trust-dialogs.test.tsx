import { errorFixture } from "../../helpers/error";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, err } from "@shared/errors";
import type { RepositoryTrustRequest } from "@shared/repository/repository";
import { RepositoryTrustDialog } from "@renderer/features/repositories/RepositoryTrustDialog";

import { deferred } from "../../helpers/deferred";
import { SshHostTrustDialog } from "@renderer/features/credentials/SshHostTrustDialog";
import type { SshHostTrustRequest } from "@shared/identity/ssh";

const ssh: SshHostTrustRequest = {
  id: "request",
  host: "example.com (192.0.2.1)",
  algorithm: "ED25519",
  fingerprint: `SHA256:${"a".repeat(43)}`,
};
const repository: RepositoryTrustRequest = {
  id: "request",
  path: "/repositories/example",
  reasons: ["filter.fixture"],
};
describe.each([
  {
    name: "SSH host",
    request: ssh,
    Component: SshHostTrustDialog,
    decline: "Cancel",
    accept: "Trust and continue",
  },
  {
    name: "repository",
    request: repository,
    Component: RepositoryTrustDialog,
    decline: "Keep disabled",
    accept: "Trust and enable",
  },
])("$name trust dialog", ({ request, Component, decline, accept }) => {
  let root: Root;
  let container: HTMLDivElement;
  let changed: (request: typeof ssh | typeof repository | null) => void;
  let pending: ReturnType<typeof vi.fn>;
  let respond: ReturnType<typeof vi.fn>;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const button = (label: string) =>
    Array.from(dialog()!.querySelectorAll("button")).find((item) => item.textContent === label)!;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    pending = vi.fn(async () => ok(null));
    respond = vi.fn(async () => ok(undefined));
    const subscribe = (handler: typeof changed) => {
      changed = handler;
      return vi.fn();
    };
    vi.stubGlobal(
      "eda",
      "host" in request
        ? {
            ssh: { pendingHostTrust: pending, respondHostTrust: respond },
            events: { onSshHostTrustChanged: subscribe },
          }
        : {
            repository: { pendingTrust: pending, respondTrust: respond },
            events: { onRepositoryTrustChanged: subscribe },
          },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const open = async () => {
    await act(async () => root.render(<Component />));
    await act(async () => changed(request));
  };

  it("shows what is being trusted and focuses the decline action", async () => {
    await open();
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(button(decline));
    if ("host" in request) {
      expect(dialog()?.textContent).toContain(request.host);
      expect(dialog()?.querySelector("code")?.textContent).toBe(request.fingerprint);
    } else {
      expect(dialog()?.textContent).toContain("filter.fixture");
      expect(dialog()?.textContent).toContain(request.path);
      expect(dialog()?.textContent).toContain("Keep them disabled unless you trust");
      const details = dialog()!.querySelector("details")!;
      expect(details.open).toBe(false);
      expect(details.querySelector("summary")?.textContent).toContain("Detected features (1)");
      await act(async () => details.querySelector("summary")!.click());
      expect(details.open).toBe(true);
      expect(details.textContent).toContain("filter.fixture");
    }
    expect(dialog()?.className).toContain("bg-bg-overlay");
    await act(async () => button(accept).click());
    expect(respond).toHaveBeenCalledWith(request.id, true);
    expect(dialog()).toBeNull();
  });

  it.each([decline, "Escape", "Close dialog"])(
    "declines trust when dismissed via %s",
    async (action) => {
      await open();
      await act(async () => {
        if (action === "Escape")
          document.activeElement?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
        else if (action === "Close dialog")
          dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
        else button(action).click();
      });
      expect(respond).toHaveBeenCalledWith(request.id, false);
      expect(dialog()).toBeNull();
    },
  );

  it("disables dismissal while the trust decision is being saved", async () => {
    const reply = deferred<ReturnType<typeof ok<void>>>();
    respond.mockReturnValueOnce(reply.promise);
    await open();
    await act(async () => button(accept).click());

    expect(button(decline).disabled).toBe(true);
    expect(
      dialog()?.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')?.disabled,
    ).toBe(true);
    await act(async () => reply.resolve(ok(undefined)));
    expect(respond.mock.calls).toEqual([[request.id, true]]);
    expect(dialog()).toBeNull();
  });

  it("closes an expired prompt without sending a trust decision", async () => {
    await open();
    await act(async () => changed(null));
    expect(dialog()).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });

  it("does not reopen an expired prompt from an older initial read", async () => {
    const initial = deferred<ReturnType<typeof ok<typeof request>>>();
    pending.mockReturnValueOnce(initial.promise);
    await act(async () => root.render(<Component />));
    await act(async () => {
      changed(request);
      changed(null);
    });
    await act(async () => initial.resolve(ok(request)));
    expect(dialog()).toBeNull();
  });

  it("recovers a pending prompt if it was emitted before the listener mounted", async () => {
    pending.mockResolvedValueOnce(ok(request));
    await act(async () => root.render(<Component />));
    expect(dialog()?.textContent).toContain("host" in request ? request.fingerprint : request.path);
  });

  it("retains the prompt and allows retry if the response fails", async () => {
    respond.mockResolvedValueOnce(
      err(
        errorFixture({ kind: "unknown", operation: "fixture", message: "Could not send decision" }),
      ),
    );
    await open();
    await act(async () => button(accept).click());
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Could not send decision");
    await act(async () => button(decline).click());
    expect(respond).toHaveBeenLastCalledWith(request.id, false);
    expect(dialog()).toBeNull();
  });

  if ("path" in request)
    it("shows the local repository warning when opening an existing folder", async () => {
      pending.mockResolvedValueOnce(ok({ id: "local", path: request.path }));
      await act(async () => root.render(<Component />));
      expect(dialog()?.textContent).toContain(request.path);
      expect(dialog()?.textContent).toContain("Keep them disabled unless you trust");
      expect(dialog()?.textContent).not.toContain("After cloning");
    });
});
