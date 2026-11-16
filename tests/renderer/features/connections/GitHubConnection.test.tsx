import { errorFixture } from "../../../helpers/error";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok } from "@shared/errors";
import { GitHubConnection } from "@renderer/features/connections/GitHubConnection";

let root: Root;
let container: HTMLDivElement;

const status = {
  secureStorage: true,
  account: null,
};

const pending = {
  id: "session",
  userCode: "ABCD-EFGH",
  intervalMs: 5000,
  expiresAt: Date.now() + 900_000,
};

const github = {
  status: vi.fn(),
  begin: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  openVerification: vi.fn(),
  disconnect: vi.fn(),
  profile: vi.fn(),
  openProfile: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const method of Object.values(github)) method.mockReset();
  github.status.mockResolvedValue(ok(status));
  github.begin.mockResolvedValue(ok(pending));
  github.poll.mockResolvedValue(ok({ state: "pending", intervalMs: 10_000 }));
  github.openVerification.mockResolvedValue(ok(undefined));
  github.cancel.mockResolvedValue(ok(undefined));
  github.disconnect.mockResolvedValue(ok(undefined));

  github.profile.mockResolvedValue(
    ok({
      id: "1",
      login: "work-user",
      name: "Work User",
      bio: "Building useful things.",
      location: "Example City",
      avatarDataUrl: "data:image/png;base64,AQID",
    }),
  );

  github.openProfile.mockResolvedValue(ok(undefined));
  vi.stubGlobal("eda", { github });
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

const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text || item.getAttribute("aria-label") === text,
  )!;

const render = () => act(async () => root.render(<GitHubConnection profileId="work" />));
const click = (text: string) => act(async () => button(text).click());

it.each([null, "", "   "])("uses the username when the GitHub display name is %j", async (name) => {
  github.status.mockResolvedValue(
    ok({ ...status, account: { id: "1", login: "work-user", state: "connected" } }),
  );
  github.profile.mockResolvedValue(
    ok({ id: "1", login: "work-user", name, bio: null, location: null, avatarDataUrl: null }),
  );

  await render();

  expect([...container.querySelectorAll("p")].map((item) => item.textContent)).toContain(
    "work-user",
  );
  expect(button("@work-user")).toBeDefined();
});

it("opens GitHub with the displayed verification code, honors polling intervals, and saves the connection", async () => {
  await render();
  await click("Sign in with GitHub");
  expect(button("Open GitHub").closest("footer")).not.toBeNull();
  expect(button("Open GitHub").dataset["variant"]).toBe("secondary");
  expect(button("Cancel").closest("footer")).not.toBeNull();
  expect(container.textContent).toContain("ABCD-EFGH");
  expect(container.textContent).not.toContain("false");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(github.openVerification).toHaveBeenCalledWith("work", "session");

  expect(
    container.querySelector('[aria-label="Waiting for GitHub"] .animate-spin-fast'),
  ).not.toBeNull();

  expect(
    container.querySelector('[aria-label="Copy code"] .ui-action-visible .lucide-check'),
  ).not.toBeNull();

  expect(container.querySelector('[aria-label="Copy code"]')?.textContent).toBe("");
  await click("Open GitHub");
  expect(github.openVerification).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(github.poll).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(9999));
  expect(github.poll).toHaveBeenCalledTimes(1);

  github.poll.mockResolvedValue(
    ok({
      state: "connected",
      status: { ...status, account: { id: "1", login: "work-user", state: "connected" } },
    }),
  );

  github.status.mockResolvedValue(
    ok({ ...status, account: { id: "1", login: "work-user", state: "connected" } }),
  );

  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(container.textContent).toContain("@work-user");
  expect(container.textContent).toContain("Work User");
  expect(container.textContent).toContain("Building useful things.");
  expect(container.textContent).toContain("Example City");

  expect(container.querySelector(".profile-avatar img")?.getAttribute("src")).toBe(
    "data:image/png;base64,AQID",
  );

  expect(github.profile).toHaveBeenCalledWith("work");
  await click("@work-user");
  expect(github.openProfile).toHaveBeenCalledWith("work");
  expect(
    [...container.querySelectorAll('[role="status"]')].map((status) => status.textContent),
  ).not.toContain("Reconnect required");
  expect(button("Reconnect GitHub")).toBeUndefined();
  expect(container.textContent).not.toContain("ABCD-EFGH");
  github.status.mockResolvedValue(ok(status));
  await click("Manage GitHub connection");
  await click("Disconnect");
  expect(github.disconnect).toHaveBeenCalledWith("work");
  expect(container.textContent).not.toContain("work-user");
  expect(container.querySelector(".profile-avatar img")).toBeNull();
});

it("does not claim the code was copied when opening GitHub fails", async () => {
  github.openVerification.mockResolvedValue(
    err(
      errorFixture({
        kind: "unknown",
        operation: "GitHub sign-in",
        message: "Could not open GitHub.",
      }),
    ),
  );

  await render();
  await click("Sign in with GitHub");

  expect(
    container.querySelector('[aria-label="Copy code"] .ui-action-visible .lucide-copy'),
  ).not.toBeNull();
});

it("cancels pending sign-in on close and does not accept a late response", async () => {
  await render();
  await click("Sign in with GitHub");
  let finish!: (value: unknown) => void;

  github.poll.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  await click("Cancel");
  await act(async () => finish(ok({ state: "connected", status })));
  expect(github.cancel).toHaveBeenCalledWith("work", "session");
  expect(button("Sign in with GitHub")).toBeDefined();
  expect(container.textContent).not.toContain("Not connected");
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(github.poll).toHaveBeenCalledTimes(1);
});

it("shows keychain availability before requesting authorization", async () => {
  github.status.mockResolvedValue(ok({ secureStorage: false, account: null }));
  await render();
  expect(button("Sign in with GitHub").disabled).toBe(true);
  expect(container.textContent).toContain("OS keychain");
  expect(github.begin).not.toHaveBeenCalled();
});

async function toggleCard(open: boolean) {
  await act(async () => {
    const details = container.querySelector("details")!;
    details.open = open;
    details.dispatchEvent(new Event("toggle"));
  });
}

it("starts compact sign-in on expansion and keeps the pending session when reopened", async () => {
  await act(async () => root.render(<GitHubConnection profileId="work" compact />));
  expect(container.querySelector("details")?.open).toBe(false);
  expect(button("Connect")).toBeUndefined();
  expect(github.begin).not.toHaveBeenCalled();
  await toggleCard(true);
  expect(github.begin).toHaveBeenCalledExactlyOnceWith("work");
  expect(github.openVerification).toHaveBeenCalledWith("work", "session");
  expect(container.textContent).toContain("ABCD-EFGH");
  expect(button("Open GitHub").closest("footer")).not.toBeNull();
  await toggleCard(false);
  await toggleCard(true);
  expect(github.begin).toHaveBeenCalledOnce();
  await click("Cancel");
  expect(container.querySelector("details")?.open).toBe(false);
  await toggleCard(false);
  await toggleCard(true);
  expect(github.begin).toHaveBeenCalledTimes(2);
});

it("collapses compact sign-in immediately after OAuth authorization and allows reopening", async () => {
  const connected = { ...status, account: { id: "1", login: "work-user", state: "connected" } };
  await act(async () => root.render(<GitHubConnection profileId="work" compact />));
  await toggleCard(true);
  github.poll.mockResolvedValue(ok({ state: "connected", status: connected }));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector('summary [aria-label="GitHub connected"]')).not.toBeNull();
  await toggleCard(true);
  expect(container.querySelector("details")?.open).toBe(true);
  expect(button("Disconnect GitHub")).toBeDefined();
  expect(github.begin).toHaveBeenCalledOnce();
});

it("expands connected details without starting sign-in and keeps status in the header", async () => {
  github.status.mockResolvedValue(
    ok({ ...status, account: { id: "1", login: "work-user", state: "connected" } }),
  );

  await act(async () => root.render(<GitHubConnection profileId="work" compact />));
  await toggleCard(true);
  expect(button("Disconnect GitHub").closest("footer")).not.toBeNull();
  await toggleCard(false);
  expect(container.querySelector('summary [aria-label="GitHub connected"]')).not.toBeNull();
  expect(github.begin).not.toHaveBeenCalled();
  await toggleCard(true);
  github.status.mockResolvedValue(ok(status));
  await click("Disconnect GitHub");
  expect(github.begin).not.toHaveBeenCalled();
  expect(container.querySelector("details")).not.toBeNull();
});

it("waits for status when expanded during loading and honors closing before it arrives", async () => {
  let finish!: (value: unknown) => void;

  github.status.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await act(async () => root.render(<GitHubConnection profileId="work" compact />));
  await toggleCard(true);
  expect(github.begin).not.toHaveBeenCalled();
  await toggleCard(false);
  await act(async () => finish(ok(status)));
  expect(github.begin).not.toHaveBeenCalled();
  await toggleCard(true);
  expect(github.begin).toHaveBeenCalledOnce();
});

it("keeps instructions and disabled actions visible while fetching the verification code", async () => {
  let finish!: (value: unknown) => void;

  github.begin.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await act(async () => root.render(<GitHubConnection profileId="work" compact />));
  await toggleCard(true);
  expect(container.textContent).toContain("Enter this code on GitHub.");
  expect(button("Open GitHub").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  expect(button("Copy code").disabled).toBe(true);
  const code = container.querySelector('[aria-label="GitHub verification code"]')!;
  expect(code.querySelectorAll(".ui-skeleton")).toHaveLength(2);
  expect(container.querySelector('summary [aria-label="Getting GitHub code"]')).not.toBeNull();
  await act(async () => finish(ok(pending)));
  expect(container.querySelector('[aria-label="GitHub verification code"]')).toBe(code);
  expect(code.textContent).toBe("ABCD-EFGH");
  expect(button("Open GitHub").disabled).toBe(false);
  expect(button("Cancel").disabled).toBe(false);
  expect(button("Copy code").disabled).toBe(false);
  await click("Cancel");
  expect(container.querySelector("details")?.open).toBe(false);
});

it.each(["rejected", "reported"])(
  "retries a %s status failure without leaving a loading placeholder",
  async (failure) => {
    if (failure === "rejected") github.status.mockRejectedValueOnce(new Error("offline"));
    else github.status.mockResolvedValueOnce(err(errorFixture({ message: "offline" })));

    await act(async () => root.render(<GitHubConnection profileId="work" />));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector(".ui-skeleton")).toBeNull();

    await act(async () => button("Retry").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Sign in with GitHub")?.disabled).toBe(false);
  },
);
