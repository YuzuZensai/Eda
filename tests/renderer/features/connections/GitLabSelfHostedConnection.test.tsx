import { fillInput } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok } from "@shared/errors";
import { errorFixture } from "../../../helpers/error";
import { GitLabSelfHostedConnection } from "@renderer/features/connections/GitLabSelfHostedConnection";

const base = "https://git.company.test/gitlab";

const account = {
  id: "7",
  login: "work.user",
  baseUrl: base,
  state: "connected",
  ignoreTlsErrors: false,
};

const api = {
  profile: vi.fn(),
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  openTokenSettings: vi.fn(),
  openProfile: vi.fn(),
  cancel: vi.fn(),
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const method of Object.values(api)) method.mockReset();
  api.status.mockResolvedValue(ok({ secureStorage: true, accounts: [] }));
  api.profile.mockImplementation(async (_profileId, baseUrl) =>
    ok({
      id: "7",
      baseUrl,
      name: "Work User",
      bio: "Building useful things.",
      location: "Example City",
      avatarDataUrl: "data:image/png;base64,AQID",
    }),
  );
  api.connect.mockResolvedValue(ok({ secureStorage: true, accounts: [account] }));
  for (const method of [api.disconnect, api.openTokenSettings, api.openProfile, api.cancel])
    method.mockResolvedValue(ok(undefined));
  vi.stubGlobal("eda", { gitlabSelfHosted: api });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent === text || node.getAttribute("aria-label") === text,
  )!;

const urlInput = () =>
  container.querySelector<HTMLInputElement>('input:not([type="password"]):not([type="checkbox"])')!;

const tokenInput = () => container.querySelector<HTMLInputElement>('input[type="password"]')!;

it.each([false, true])("shows the shared profile layout with compact=%j", async (compact) => {
  api.status.mockResolvedValue(ok({ secureStorage: true, accounts: [account] }));
  await act(async () =>
    root.render(<GitLabSelfHostedConnection profileId="work" compact={compact} />),
  );

  expect(container.textContent).toContain("Work User");
  expect(container.textContent).toContain("Building useful things.");
  expect(container.textContent).toContain("Example City");
  expect(container.textContent).toContain(base);
  expect(container.querySelector(".profile-avatar img")?.getAttribute("src")).toBe(
    "data:image/png;base64,AQID",
  );
  await act(async () => button("@work.user").click());
  expect(api.openProfile).toHaveBeenCalledWith("work", base);
});

it("keeps the avatar skeleton visible until the matching self-hosted profile is ready", async () => {
  api.status.mockResolvedValue(ok({ secureStorage: true, accounts: [account] }));
  let finish!: (value: unknown) => void;
  api.profile.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" />));
  expect(container.querySelector(".profile-avatar.ui-skeleton")).not.toBeNull();
  expect(button("@work.user")?.disabled).toBe(true);

  await act(async () =>
    finish(ok({ id: "7", baseUrl: base, name: "Work User", avatarDataUrl: null })),
  );
  expect(container.querySelector(".ui-skeleton")).toBeNull();
  expect(container.textContent).toContain("Work User");
  expect(button("@work.user")).toBeDefined();
});

it("keeps profiles with matching account IDs separate across self-hosted instances", async () => {
  const other = "https://other.company.test";
  api.status.mockResolvedValue(
    ok({ secureStorage: true, accounts: [account, { ...account, baseUrl: other }] }),
  );
  api.profile.mockImplementation(async (_profileId, baseUrl) =>
    ok({
      id: "7",
      baseUrl,
      name: baseUrl === base ? "Work User" : "Other User",
      avatarDataUrl: null,
    }),
  );
  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" />));

  expect(container.textContent).toContain("Work User");
  expect(container.textContent).toContain("Other User");
  expect(container.querySelectorAll(".profile-avatar")).toHaveLength(2);
});

it("uses the username when profile loading fails and rejects details from a different instance", async () => {
  api.status.mockResolvedValue(ok({ secureStorage: true, accounts: [account] }));
  api.profile.mockResolvedValue(
    ok({ id: "7", baseUrl: "https://other.company.test", name: "Wrong User", avatarDataUrl: null }),
  );
  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" />));
  expect(container.textContent).not.toContain("Wrong User");
  expect([...container.querySelectorAll("p")].map((item) => item.textContent)).toContain(
    "work.user",
  );

  api.profile.mockRejectedValue(new Error("Offline"));
  await act(async () => root.render(<GitLabSelfHostedConnection key="retry" profileId="work" />));
  expect(button("@work.user")).toBeDefined();
  expect(container.querySelector(".ui-skeleton")).toBeNull();
});

async function startSetup() {
  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" />));
  await act(async () => button("Connect instance").click());
  await fillInput(urlInput(), base);
  await act(async () => button("Next").click());
}

it("keeps the integration card compact until setup is opened", async () => {
  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" />));

  expect(urlInput()).toBeNull();
  expect(tokenInput()).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain("permissions");
  expect(button("Connect instance")).toBeDefined();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("keeps every setup step inside the provider card without opening a dialog", async () => {
  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" />));
  await act(async () => button("Connect instance").click());

  const card = container.querySelector('[aria-label="GitLab Self-Hosted connection"]')!;

  expect(card.querySelector('[role="status"] .animate-spin-fast')).toBeNull();

  expect(card.contains(urlInput())).toBe(true);
  expect(card.querySelector('ol, [aria-current="step"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Next").disabled).toBe(true);
  expect(tokenInput()).toBeNull();

  await fillInput(urlInput(), base);
  await act(async () => button("Next").click());

  expect(urlInput()).toBeNull();
  expect(card.contains(tokenInput())).toBe(true);
  expect(document.querySelector("details")).toBeNull();
  expect(button("I already have a token")).toBeUndefined();
  expect(button("Connect").disabled).toBe(true);
  expect(card.textContent).not.toContain("Legacy scopes");

  await act(async () => button("Legacy token").click());

  expect(api.openTokenSettings).toHaveBeenCalledWith("work", base, "legacy");
  expect(card.contains(tokenInput())).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  await fillInput(tokenInput(), "private-token");
  await act(async () => button("Connect").click());

  expect(api.connect).toHaveBeenCalledWith("work", base, "private-token", false);
  expect(container.querySelector('[aria-label="Connection setup"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("@work.user");
  expect(container.textContent).not.toContain("private-token");
});

it.each([
  ["Fine-grained token", "granular"],
  ["For older GitLab versions", "older"],
])("opens %s without hiding or clearing the token field", async (label, form) => {
  await startSetup();
  await fillInput(tokenInput(), "private-token");
  const input = tokenInput();

  await act(async () => button(label).click());

  expect(api.openTokenSettings).toHaveBeenCalledWith("work", base, form);
  expect(tokenInput()).toBe(input);
  expect(tokenInput().value).toBe("private-token");
});

it("clears the secret after failure and when navigating back to change the server", async () => {
  await startSetup();
  await fillInput(tokenInput(), "private-token");

  api.connect.mockResolvedValueOnce({
    ok: false,
    error: errorFixture({ kind: "auth-failed", message: "Connection failed" }),
  });

  await act(async () => button("Connect").click());

  expect(tokenInput().value).toBe("");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Connection failed");

  await fillInput(tokenInput(), "replacement-token");
  await act(async () => button("Back").click());

  expect(urlInput().value).toBe(base);

  await fillInput(urlInput(), "https://another.test");
  await act(async () => button("Next").click());

  expect(tokenInput().value).toBe("");
});

it("opens account profiles, updates tokens and disconnects", async () => {
  api.status.mockResolvedValueOnce(ok({ secureStorage: true, accounts: [account] }));
  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" />));
  expect(button("Add instance")).toBeDefined();
  expect(container.querySelectorAll(`[aria-label="View work.user on ${base}"]`)).toHaveLength(1);
  expect(container.textContent).not.toContain("Connected");
  await act(async () => button("@work.user").click());

  expect(api.openProfile).toHaveBeenCalledWith("work", base);

  await act(async () => button(`Manage ${base} connection`).click());
  await act(async () => button("Update token").click());
  expect(tokenInput()).not.toBeNull();
  await act(async () => button("Back").click());

  expect(urlInput().value).toBe(base);

  await act(async () => button("Cancel").click());
  await act(async () => button(`Manage ${base} connection`).click());
  await act(async () => button("Disconnect instance").click());

  expect(api.disconnect).toHaveBeenCalledWith("work", base);
  expect(container.textContent).not.toContain("@work.user");
});

it("keeps a saved account available in the compact onboarding disclosure", async () => {
  api.status.mockResolvedValueOnce(ok({ secureStorage: true, accounts: [account] }));
  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" compact />));
  expect(container.querySelector("details")).not.toBeNull();
  expect(button("@work.user")).toBeDefined();
});

it("lets users opt into ignoring TLS errors and restores the saved choice when editing", async () => {
  await startSetup();
  const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox().checked).toBe(false);
  await act(async () => checkbox().click());
  await fillInput(tokenInput(), "private-token");

  api.connect.mockResolvedValueOnce(
    ok({ secureStorage: true, accounts: [{ ...account, ignoreTlsErrors: true }] }),
  );

  await act(async () => button("Connect").click());
  expect(api.connect).toHaveBeenCalledWith("work", base, "private-token", true);

  await act(async () => button(`Manage ${base} connection`).click());
  await act(async () => button("Update token").click());
  expect(checkbox().checked).toBe(true);
  await act(async () => button("Back").click());
  await fillInput(urlInput(), "https://other.company.test");
  expect(checkbox().checked).toBe(false);
});

it("cancels a pending connection when setup closes and ignores its late response", async () => {
  let finish!: (result: unknown) => void;

  api.connect.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  await startSetup();
  await fillInput(tokenInput(), "private-token");
  await act(async () => button("Connect").click());
  expect(container.querySelector('[role="status"] .animate-spin-fast')).not.toBeNull();
  await act(async () => button("Cancel").click());

  expect(api.cancel).toHaveBeenCalledWith("work");

  await act(async () => finish(ok({ secureStorage: true, accounts: [account] })));

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain("@work.user");
});

it("cancels a pending connection when its profile view unmounts", async () => {
  api.connect.mockReturnValueOnce(new Promise(() => {}));
  await startSetup();
  await fillInput(tokenInput(), "private-token");
  await act(async () => button("Connect").click());
  await act(async () => root.render(null));

  expect(api.cancel).toHaveBeenCalledWith("work");
});

it("allows setup with locked storage but blocks saving and explains how to unlock it", async () => {
  api.status.mockResolvedValueOnce(ok({ secureStorage: false, accounts: [] }));
  await act(async () => root.render(<GitLabSelfHostedConnection profileId="work" />));

  expect(tokenInput()).toBeNull();
  expect(button("Connect instance").disabled).toBe(false);

  await act(async () => button("Connect instance").click());
  await fillInput(urlInput(), base);
  await act(async () => button("Next").click());
  await fillInput(tokenInput(), "private-token");

  expect(button("Connect").disabled).toBe(true);
  expect(document.body.textContent).toContain("OS keychain");
  expect(api.connect).not.toHaveBeenCalled();
});

it("handles Enter inside onboarding without submitting the outer form", async () => {
  const submit = vi.fn((event) => event.preventDefault());

  await act(async () =>
    root.render(
      <form onSubmit={submit}>
        <GitLabSelfHostedConnection profileId="work" />
      </form>,
    ),
  );

  await act(async () => button("Connect instance").click());
  await fillInput(urlInput(), base);

  await act(async () =>
    urlInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );

  expect(button("Legacy token")).toBeDefined();
  expect(container.querySelector("form form")).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});
