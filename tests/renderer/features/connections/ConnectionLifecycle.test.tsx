import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok } from "@shared/errors";
import { GitHubConnection } from "@renderer/features/connections/GitHubConnection";
import { GitLabConnection } from "@renderer/features/connections/GitLabConnection";

const empty = { secureStorage: true, account: null };
const connected = {
  secureStorage: true,
  account: { id: "7", login: "work.user", state: "connected" },
};
const profile = {
  id: "7",
  login: "work.user",
  name: "Work User",
  bio: null,
  location: null,
  avatarDataUrl: null,
};

function pendingResult() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe.each([
  { provider: "GitHub", apiName: "github", Component: GitHubConnection },
  { provider: "GitLab", apiName: "gitlab", Component: GitLabConnection },
])("$provider profile lifecycle", ({ provider, apiName, Component }) => {
  let root: Root;
  let container: HTMLDivElement;
  const api = {
    status: vi.fn(),
    profile: vi.fn(),
    begin: vi.fn(),
    poll: vi.fn(),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    openProfile: vi.fn(),
    openVerification: vi.fn(),
    openAuthorization: vi.fn(),
  };
  const session = (id: string) => ({
    id,
    userCode: id,
    intervalMs: 1000,
    expiresAt: Date.now() + 60_000,
  });
  const render = (profileId: string) =>
    act(async () => root.render(<Component profileId={profileId} />));
  const click = (label: string) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent === label || item.getAttribute("aria-label") === label,
      );
      expect(button).toBeDefined();
      button!.click();
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    for (const method of Object.values(api)) method.mockReset().mockResolvedValue(ok(undefined));
    api.status.mockResolvedValue(ok(empty));
    api.profile.mockResolvedValue(ok(profile));
    api.begin.mockResolvedValue(ok(session("session")));
    api.poll.mockResolvedValue(ok({ state: "pending", intervalMs: 1000 }));
    vi.stubGlobal("eda", { [apiName]: api });
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

  it("ignores status results from the previous profile", async () => {
    const previous = pendingResult();
    api.status.mockReturnValueOnce(previous.promise);
    await render("work");
    await render("personal");
    await act(async () => previous.resolve(ok(connected)));
    expect(container.textContent).not.toContain("@work.user");
    expect(container.textContent).toContain(`Sign in with ${provider}`);
    expect(api.profile).not.toHaveBeenCalled();
  });

  it("copies sign-in and profile URLs through the guarded provider actions", async () => {
    vi.stubGlobal("eda", { [apiName]: api, app: { platform: "linux" } });
    await render("work");
    await click(`Sign in with ${provider}`);
    const open = provider === "GitHub" ? api.openVerification : api.openAuthorization;
    open.mockClear();

    await act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === `Open ${provider}`,
      )!;
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    expect(open).toHaveBeenCalledExactlyOnceWith("work", "session", true);

    await render("personal");
    api.status.mockResolvedValue(ok(connected));
    await render("connected");
    await act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === "@work.user",
      )!;
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    expect(api.openProfile).toHaveBeenCalledExactlyOnceWith("connected", true);
  });

  it("clears profile details and waits for the new profile even when account IDs match", async () => {
    api.status.mockResolvedValue(ok(connected));
    await render("work");
    expect(container.textContent).toContain("Work User");
    const next = pendingResult();
    api.profile.mockReturnValueOnce(next.promise);
    await render("personal");
    expect(container.textContent).not.toContain("Work User");
    expect(container.querySelector(".profile-avatar.ui-skeleton")).not.toBeNull();
    await act(async () => next.resolve(ok({ ...profile, name: "Personal User" })));
    expect(container.textContent).toContain("Personal User");
    expect(container.querySelector(".ui-skeleton")).toBeNull();
  });

  it("ignores late account details from the previous profile", async () => {
    api.status.mockResolvedValue(ok(connected));
    const previous = pendingResult();
    api.profile.mockReturnValueOnce(previous.promise);
    await render("work");
    api.profile.mockResolvedValue(ok({ ...profile, name: "Personal User" }));
    await render("personal");
    await act(async () => previous.resolve(ok(profile)));
    expect(container.textContent).toContain("Personal User");
    expect(container.textContent).not.toContain("Work User");
  });

  it("cancels a late sign-in start for the old profile without replacing the new session", async () => {
    const previous = pendingResult();
    api.begin.mockReturnValueOnce(previous.promise);
    await render("work");
    await click(`Sign in with ${provider}`);
    await render("personal");
    api.begin.mockResolvedValue(ok(session("personal-session")));
    await click(`Sign in with ${provider}`);
    await act(async () => previous.resolve(ok(session("work-session"))));
    expect(api.cancel).toHaveBeenCalledWith("work", "work-session");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.poll).toHaveBeenCalledWith("personal", "personal-session");
    expect(api.openVerification).not.toHaveBeenCalledWith("work", "work-session");
    expect(api.openAuthorization).not.toHaveBeenCalledWith("work", "work-session");
  });

  it("cancels the old session and ignores its in-flight poll after switching profiles", async () => {
    const previous = pendingResult();
    api.poll.mockReturnValueOnce(previous.promise);
    await render("work");
    await click(`Sign in with ${provider}`);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await render("personal");
    await act(async () => previous.resolve(ok({ state: "connected", status: connected })));
    expect(api.cancel).toHaveBeenCalledWith("work", "session");
    expect(container.textContent).not.toContain("@work.user");
    expect(container.textContent).toContain(`Sign in with ${provider}`);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.poll).toHaveBeenCalledOnce();
  });

  it("ignores disconnect completion from the previous profile", async () => {
    api.status.mockResolvedValue(ok(connected));
    const previous = pendingResult();
    api.disconnect.mockReturnValueOnce(previous.promise);
    await render("work");
    await click(`Manage ${provider} connection`);
    await click(provider === "GitHub" ? "Disconnect" : "Disconnect GitLab");
    await render("personal");
    await act(async () => previous.resolve(ok(undefined)));
    expect(container.textContent).toContain("@work.user");
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it("ignores a late browser failure from a cancelled sign-in after starting another session", async () => {
    await render("work");
    await click(`Sign in with ${provider}`);
    const browser = pendingResult();
    const open = provider === "GitHub" ? api.openVerification : api.openAuthorization;
    open.mockReturnValueOnce(browser.promise);
    await click(`Open ${provider}`);
    await click("Cancel");
    api.begin.mockResolvedValue(ok(session("next-session")));
    await click(`Sign in with ${provider}`);

    await act(async () => browser.reject(new Error("Browser failed to open")));

    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.poll).toHaveBeenCalledWith("work", "next-session");
  });

  it("clears a successfully disconnected account even when status refresh is unavailable", async () => {
    api.status.mockResolvedValue(ok(connected));
    await render("work");
    api.status.mockRejectedValue(new Error("Status unavailable"));

    await click(`Manage ${provider} connection`);
    await click(provider === "GitHub" ? "Disconnect" : "Disconnect GitLab");

    expect(container.textContent).not.toContain("@work.user");
    expect(container.textContent).toContain(`Sign in with ${provider}`);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
