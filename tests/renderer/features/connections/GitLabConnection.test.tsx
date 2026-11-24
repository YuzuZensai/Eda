import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deferred } from "../../../helpers/deferred";
import { errorFixture } from "../../../helpers/error";
import { err, ok } from "@shared/errors";
import { GitLabConnection } from "@renderer/features/connections/GitLabConnection";
import { ProviderConnections } from "@renderer/features/connections/ProviderConnections";

const gitlab = {
  profile: vi.fn(),
  status: vi.fn(),
  begin: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  openAuthorization: vi.fn(),
  openProfile: vi.fn(),
  disconnect: vi.fn(),
};
const gitHosts = { accounts: vi.fn() };

const empty = { secureStorage: true, account: null };

const connected = {
  secureStorage: true,
  account: { id: "7", login: "work.user", state: "connected" },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const method of Object.values(gitlab)) method.mockReset();
  gitHosts.accounts.mockReset().mockResolvedValue(ok([]));
  gitlab.status.mockResolvedValue(ok(empty));
  gitlab.profile.mockResolvedValue(
    ok({
      id: "7",
      name: "Work User",
      bio: "Building useful things.",
      location: "Example City",
      avatarDataUrl: "data:image/png;base64,AQID",
    }),
  );
  gitlab.begin.mockResolvedValue(ok({ id: "session", expiresAt: Date.now() + 600_000 }));
  gitlab.poll.mockResolvedValue(ok({ state: "pending" }));

  for (const method of [
    gitlab.cancel,
    gitlab.openAuthorization,
    gitlab.openProfile,
    gitlab.disconnect,
  ])
    method.mockResolvedValue(ok(undefined));

  vi.stubGlobal("eda", {
    gitlab,
    gitlabSelfHosted: { status: vi.fn(async () => ok({ secureStorage: true, accounts: [] })) },
    github: { status: vi.fn(async () => ok(empty)) },
    gitHosts,
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

const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find(
    (item) => item.textContent === text || item.getAttribute("aria-label") === text,
  )!;

it("opens browser authorization, completes the account connection and disconnects", async () => {
  await act(async () => root.render(<GitLabConnection profileId="work" />));
  await act(async () => button("Sign in with GitLab").click());
  expect(button("Open GitLab").closest("footer")).not.toBeNull();
  expect(button("Open GitLab").dataset["variant"]).toBe("secondary");
  expect(button("Cancel").closest("footer")).not.toBeNull();
  expect(gitlab.openAuthorization).toHaveBeenCalledWith("work", "session");
  expect(container.textContent).toContain("Authorize Eda in your browser");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  gitlab.poll.mockResolvedValue(ok({ state: "connected", status: connected }));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container.textContent).toContain("@work.user");
  expect(container.textContent).toContain("Work User");
  expect(container.textContent).toContain("Building useful things.");
  expect(container.textContent).toContain("Example City");

  expect(container.querySelector(".profile-avatar img")?.getAttribute("src")).toBe(
    "data:image/png;base64,AQID",
  );

  expect(container.textContent).not.toContain("Authorize Eda");
  await act(async () => button("@work.user").click());
  expect(gitlab.openProfile).toHaveBeenCalledWith("work");
  await act(async () => button("Manage GitLab connection").click());
  await act(async () => button("Disconnect GitLab").click());
  expect(gitlab.disconnect).toHaveBeenCalledWith("work");
  expect(container.textContent).not.toContain("@work.user");
});

it("shows the same full profile in the compact connection without restarting sign-in", async () => {
  gitlab.status.mockResolvedValue(ok(connected));
  await act(async () => root.render(<GitLabConnection profileId="work" compact />));
  await act(async () => {
    const details = container.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });

  expect(container.textContent).toContain("Work User");
  expect(container.textContent).toContain("Building useful things.");
  expect(container.textContent).toContain("Example City");
  await act(async () => button("@work.user").click());
  expect(gitlab.openProfile).toHaveBeenCalledWith("work");
  expect(gitlab.begin).not.toHaveBeenCalled();
});

it.each([null, "", "   "])("uses the username when the GitLab display name is %j", async (name) => {
  gitlab.status.mockResolvedValue(ok(connected));
  gitlab.profile.mockResolvedValue(
    ok({ id: "7", name, bio: null, location: null, avatarDataUrl: null }),
  );
  await act(async () => root.render(<GitLabConnection profileId="work" />));

  expect([...container.querySelectorAll("p")].map((item) => item.textContent)).toContain(
    "work.user",
  );
  expect(button("@work.user")).toBeDefined();
});

it("ignores a late poll response after cancellation", async () => {
  await act(async () => root.render(<GitLabConnection profileId="work" />));
  await act(async () => button("Sign in with GitLab").click());
  let finish!: (value: unknown) => void;

  gitlab.poll.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => button("Cancel").click());
  await act(async () => finish(ok({ state: "connected", status: connected })));
  expect(gitlab.cancel).toHaveBeenCalledWith("work", "session");
  expect(button("Sign in with GitLab")).toBeDefined();
  expect(container.textContent).not.toContain("@work.user");
});

it("offers self-hosted PAT setup alongside GitLab.com browser sign-in", async () => {
  await act(async () => root.render(<ProviderConnections profileId="work" />));
  const hosted = container.querySelector('[aria-label="GitLab connection"]')!;
  const selfHosted = container.querySelector('[aria-label="GitLab Self-Hosted connection"]')!;
  expect(hosted.textContent).toContain("Sign in with GitLab");
  expect(selfHosted.textContent).toContain("Connect instance");
  expect(selfHosted.querySelector("input")).toBeNull();
  expect(selfHosted.textContent).not.toContain("Coming soon");
});

it("shows each additional Git service as its own card with its own accounts and setup", async () => {
  const enterpriseAccount = {
    kind: "github-enterprise",
    username: "team.user",
    base: "https://git.example.test",
  };
  const bitbucketAccount = {
    kind: "bitbucket-cloud",
    username: "team@example.test",
    base: "https://bitbucket.org/team",
  };
  const savedAccounts = ok([enterpriseAccount, bitbucketAccount]);
  const pending = deferred<typeof savedAccounts>();
  gitHosts.accounts.mockReturnValue(pending.promise);

  await act(async () => root.render(<ProviderConnections profileId="work" />));

  const card = (title: string) => container.querySelector(`section[aria-label="${title}"]`)!;
  const enterprise = card("GitHub Enterprise Server");
  const bitbucketCloud = card("Bitbucket Cloud");
  const bitbucketDataCenter = card("Bitbucket Data Center");
  const azure = card("Azure DevOps Services");

  const providers = [enterprise, bitbucketCloud, bitbucketDataCenter, azure];
  for (const provider of providers) {
    expect(button("Add host", provider).disabled).toBe(true);
  }

  await act(async () => pending.resolve(savedAccounts));

  for (const provider of providers) {
    expect(button("Add host", provider).disabled).toBe(false);
    expect(provider.querySelector('input[type="password"]')).toBeNull();
  }

  expect(gitHosts.accounts).toHaveBeenCalledWith("work");
  expect(enterprise.textContent).toContain(enterpriseAccount.base);
  expect(enterprise.textContent).not.toContain(bitbucketAccount.base);
  expect(bitbucketCloud.textContent).toContain(bitbucketAccount.base);
  expect(bitbucketDataCenter.textContent).not.toContain(bitbucketAccount.base);

  await act(async () => button("Add host", bitbucketCloud).click());
  expect(bitbucketCloud.querySelectorAll("input")).toHaveLength(1);
  expect(bitbucketCloud.querySelector('input[type="password"]')).toBeNull();
  expect(bitbucketCloud.textContent).toContain("Bitbucket workspace URL");
  expect(button("Next", bitbucketCloud).disabled).toBe(true);
  expect(enterprise.querySelector("input")).toBeNull();

  await act(async () => button("Cancel", bitbucketCloud).click());
  expect(bitbucketCloud.querySelector("input")).toBeNull();
  expect(bitbucketCloud.textContent).toContain(bitbucketAccount.base);
});

it("reveals the cached profile and avatar together without flashing initials during loading", async () => {
  gitlab.status.mockResolvedValue(ok(connected));
  let finish!: (value: unknown) => void;

  gitlab.profile.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await act(async () => root.render(<GitLabConnection profileId="work" />));
  expect(container.querySelector(".ui-skeleton")).not.toBeNull();
  expect(container.querySelector(".profile-avatar.ui-skeleton")).not.toBeNull();
  expect(button("@work.user").disabled).toBe(true);
  await act(async () => finish(ok({ id: "7", avatarDataUrl: "data:image/png;base64,AQID" })));
  expect(container.querySelector(".ui-skeleton")).toBeNull();
  expect(container.textContent).toContain("@work.user");

  expect(container.querySelector(".profile-avatar img")?.getAttribute("src")).toBe(
    "data:image/png;base64,AQID",
  );
});

it.each(["rejected", "reported"])(
  "retries a %s status failure without leaving a loading placeholder",
  async (failure) => {
    if (failure === "rejected") gitlab.status.mockRejectedValueOnce(new Error("offline"));
    else gitlab.status.mockResolvedValueOnce(err(errorFixture({ message: "offline" })));

    await act(async () => root.render(<GitLabConnection profileId="work" />));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector(".ui-skeleton")).toBeNull();

    await act(async () => button("Retry").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Sign in with GitLab")?.disabled).toBe(false);
  },
);
