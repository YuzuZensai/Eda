import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { INTEGRATIONS } from "@shared/integrations/config";
import { GitLabAuth } from "@main/providers/gitlab-auth";
import { ProviderAccountRepository } from "@main/persistence/provider-account-repository";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import type { SecretStore } from "@main/secrets/secret-store";
import { deferred } from "../../helpers/deferred";

const callbacks = vi.hoisted(
  () =>
    [] as {
      state: string;
      received: (code?: string, error?: string) => void;
      close: ReturnType<typeof vi.fn>;
    }[],
);

vi.mock("@main/providers/gitlab-oauth-callback", () => ({
  GitLabOAuthCallback: class {
    close = vi.fn();
    constructor(_uri: string, state: string, received: (code?: string, error?: string) => void) {
      callbacks.push({ state, received, close: this.close });
    }
    async listen() {}
  },
}));

const databases: Database[] = [];
const services: GitLabAuth[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.cancelAll();
  for (const db of databases.splice(0)) db.close();
  callbacks.splice(0);
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const token = {
  access_token: "gitlab-access",
  refresh_token: "gitlab-refresh",
  expires_in: 7200,
  token_type: "Bearer",
};

const profileFields = {
  name: "Work User",
  bio: "Building useful things.\nOpen source contributor.",
  location: "Example City",
};

function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const identities = new IdentityRepository(db);

  const profile = identities.create({
    name: "Work",
    gitName: "Work",
    gitEmail: "work@example.com",
    hue: 210,
    signing: { format: "none", signCommits: false },
  });

  const other = identities.create({ ...profile, name: "Personal" });
  const values = new Map<string, string>();

  const secrets: SecretStore = {
    available: true,
    get: vi.fn(async (key) => values.get(key)),
    set: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key) => {
      values.delete(key);
    }),
    deleteForIdentity: vi.fn(async () => {}),
  };

  const fetch = vi.fn<typeof globalThis.fetch>();
  let now = Date.now();
  const accounts = new ProviderAccountRepository(db, "gitlab");
  const service = new GitLabAuth(accounts, secrets, fetch, () => now);
  services.push(service);

  const connect = async () => {
    const signIn = await service.begin(profile.id);

    fetch
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ id: 7, username: "work.user", ...profileFields }));

    callbacks.at(-1)!.received("private-code");
    await vi.waitFor(() => expect(service.status(profile.id).account?.state).toBe("connected"));
    expect(service.poll(profile.id, signIn.id)).toMatchObject({ state: "connected" });
    return signIn;
  };

  return {
    now: () => now,
    db,
    identities,
    profile,
    other,
    values,
    secrets,
    fetch,
    accounts,
    service,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("uses PKCE without a client secret, verifies account identity and stores only a profile-owned connection", async () => {
  const ctx = setup();
  const signIn = await ctx.service.begin(ctx.profile.id);
  const url = new URL(ctx.service.authorizationUrl(ctx.profile.id, signIn.id));
  expect(url.origin + url.pathname).toBe("https://gitlab.com/oauth/authorize");
  expect(url.searchParams.get("client_id")).toBe(INTEGRATIONS.gitlab.clientId);
  expect(url.searchParams.get("scope")).toBe("read_user read_api write_repository");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).toBe(callbacks.at(-1)!.state);
  expect(Object.keys(signIn).sort()).toEqual(["expiresAt", "id"]);
  expect(ctx.service.poll(ctx.profile.id, signIn.id)).toEqual({ state: "pending" });
  expect(() => ctx.service.authorizationUrl(ctx.other.id, signIn.id)).toThrow(/another profile/);

  ctx.fetch
    .mockResolvedValueOnce(json(token))
    .mockResolvedValueOnce(json({ id: 7, username: "work.user", ...profileFields }));

  callbacks.at(-1)!.received("private-code");

  await vi.waitFor(() =>
    expect(ctx.service.status(ctx.profile.id).account?.state).toBe("connected"),
  );

  const form = new URLSearchParams(String(ctx.fetch.mock.calls[0]?.[1]?.body));
  expect(form.get("code")).toBe("private-code");
  expect(form.has("client_secret")).toBe(false);

  expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(
    url.searchParams.get("code_challenge"),
  );

  expect(form.get("redirect_uri")).toBe(INTEGRATIONS.gitlab.redirectUri);

  expect(ctx.service.poll(ctx.profile.id, signIn.id)).toMatchObject({
    state: "connected",
    status: { account: { id: "7", login: "work.user" } },
  });

  expect(JSON.stringify(ctx.service.status(ctx.profile.id))).not.toContain(token.access_token);
  expect(JSON.stringify(ctx.accounts.find(ctx.profile.id))).not.toContain(token.refresh_token);
  expect(ctx.service.status(ctx.other.id).account).toBeNull();
  expect(ctx.service.profileUrl(ctx.profile.id)).toBe("https://gitlab.com/work.user");
  expect(await ctx.service.profile(ctx.profile.id)).toEqual({
    id: "7",
    ...profileFields,
    avatarUrl: null,
  });
});

it("renews once for concurrent Git requests and uses the rotated refresh token after a restart", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.advance(token.expires_in * 1000);
  const remote = "https://gitlab.com/team/subgroup/invited.git";
  ctx.fetch.mockClear();

  ctx.fetch
    .mockResolvedValueOnce(
      json({ ...token, access_token: "rotated-access", refresh_token: "rotated-refresh" }),
    )
    .mockResolvedValueOnce(json({ id: 7, username: "work.user", ...profileFields }));

  const creds = await Promise.all([1, 2].map(() => ctx.service.forFetch(ctx.profile.id, remote)));

  expect(creds).toEqual(Array(2).fill({ username: "oauth2", password: "rotated-access" }));
  expect(ctx.fetch).toHaveBeenCalledTimes(2);
  const form = new URLSearchParams(String(ctx.fetch.mock.calls[0]?.[1]?.body));
  expect(form.get("grant_type")).toBe("refresh_token");
  expect(form.get("refresh_token")).toBe(token.refresh_token);
  expect(form.has("client_secret")).toBe(false);
  expect([...ctx.values.values()].join()).not.toContain(token.refresh_token);
  expect(await ctx.service.profile(ctx.profile.id)).toEqual({
    id: "7",
    ...profileFields,
    avatarUrl: null,
  });

  ctx.advance(30 * 24 * 60 * 60 * 1000);
  const restarted = new GitLabAuth(ctx.accounts, ctx.secrets, ctx.fetch, ctx.now);
  services.push(restarted);
  ctx.fetch.mockClear();
  ctx.fetch
    .mockResolvedValueOnce(
      json({ ...token, access_token: "next-access", refresh_token: "next-refresh" }),
    )
    .mockResolvedValueOnce(json({ id: 7, username: "work.user", ...profileFields }));

  expect(await restarted.forFetch(ctx.profile.id, remote)).toEqual({
    username: "oauth2",
    password: "next-access",
  });
  const renewal = new URLSearchParams(String(ctx.fetch.mock.calls[0]?.[1]?.body));
  expect(renewal.get("refresh_token")).toBe("rotated-refresh");
  expect(restarted.status(ctx.profile.id).account?.state).toBe("connected");

  await restarted.disconnect(ctx.profile.id);
  expect(ctx.accounts.find(ctx.profile.id)).toBeUndefined();
  expect(ctx.values.size).toBe(0);
});

it("does not reuse rotated refresh tokens from a delayed concurrent vault read", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.advance(7_200_000);
  const saved = [...ctx.values.values()][0];
  const delayed = deferred<string | undefined>();
  vi.mocked(ctx.secrets.get).mockResolvedValueOnce(saved).mockReturnValueOnce(delayed.promise);
  ctx.fetch.mockClear();
  ctx.fetch
    .mockResolvedValueOnce(
      json({ ...token, access_token: "rotated-access", refresh_token: "rotated-refresh" }),
    )
    .mockResolvedValueOnce(json({ id: 7, username: "work.user" }))
    .mockResolvedValueOnce(json({ error: "invalid_grant" }));

  const first = ctx.service.forFetch(ctx.profile.id, "https://gitlab.com/org/repo");
  const second = ctx.service.forFetch(ctx.profile.id, "https://gitlab.com/org/repo");
  const result = expect(second).resolves.toEqual({
    username: "oauth2",
    password: "rotated-access",
  });
  await first;
  delayed.resolve(saved);

  await result;
  expect(ctx.fetch).toHaveBeenCalledTimes(2);
  expect(ctx.service.status(ctx.profile.id).account?.state).toBe("connected");
});

it("never supplies tokens to other profiles, hosts, self-hosted GitLab, SSH, or malformed remotes", async () => {
  const ctx = setup();
  await ctx.connect();

  expect(
    await ctx.service.forFetch(ctx.other.id, "https://gitlab.com/team/repo.git"),
  ).toBeUndefined();

  for (const url of [
    "https://gitlab.company.test/team/repo.git",
    "https://gitlab.com.evil.test/team/repo",
    "https://gitlab.com@evil.test/team/repo",
    "http://gitlab.com/team/repo",
    "https://gitlab.com/team/repo?redirect=evil",
    "https://github.com/team/repo",
    "git@gitlab.com:team/repo.git",
    "https://gitlab.com/team",
  ]) {
    expect(await ctx.service.forFetch(ctx.profile.id, url)).toBeUndefined();
  }

  const saved = ctx.accounts.find(ctx.profile.id)!;
  ctx.accounts.save({ ...saved, profileId: ctx.other.id });

  await expect(
    ctx.service.forFetch(ctx.other.id, "https://gitlab.com/team/repo"),
  ).rejects.toMatchObject({ kind: "auth-failed" });

  await ctx.service.disconnect(ctx.other.id);
  expect(ctx.values.size).toBe(1);
});

it("preserves an existing connection when new authorization is cancelled during a vault write", async () => {
  const ctx = setup();
  await ctx.connect();
  const saved = ctx.accounts.find(ctx.profile.id);
  const signIn = await ctx.service.begin(ctx.profile.id);
  const write = ctx.secrets.set;

  ctx.secrets.set = vi.fn(async (key, value) => {
    await write(key, value);
    ctx.service.cancel(ctx.profile.id, signIn.id);
  });

  ctx.fetch
    .mockResolvedValueOnce(json(token))
    .mockResolvedValueOnce(json({ id: 8, username: "another-user" }));

  callbacks.at(-1)!.received("code");
  await vi.waitFor(() => expect(ctx.secrets.delete).toHaveBeenCalled());
  expect(ctx.accounts.find(ctx.profile.id)).toEqual(saved);
  expect(ctx.values.size).toBe(1);
});

it("handles rejection, expiry, profile switches and locked storage without saving credentials", async () => {
  const ctx = setup();
  let signIn = await ctx.service.begin(ctx.profile.id);
  callbacks.at(-1)!.received(undefined, "access_denied");
  expect(() => ctx.service.poll(ctx.profile.id, signIn.id)).toThrow(/declined/);
  signIn = await ctx.service.begin(ctx.profile.id);
  ctx.advance(601_000);
  expect(() => ctx.service.poll(ctx.profile.id, signIn.id)).toThrow(/expired/);
  signIn = await ctx.service.begin(ctx.profile.id);
  ctx.service.cancelAll();
  expect(() => ctx.service.poll(ctx.profile.id, signIn.id)).toThrow(/cancelled/);
  const locked = new GitLabAuth(ctx.accounts, { ...ctx.secrets, available: false }, ctx.fetch);

  await expect(locked.begin(ctx.profile.id)).rejects.toMatchObject({
    kind: "keychain-unavailable",
  });

  expect(ctx.values.size).toBe(0);
});

it("marks invalid refresh tokens expired while preserving a connection on temporary network errors", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.advance(8_000_000);
  ctx.fetch.mockRejectedValueOnce(new Error("offline"));

  await expect(
    ctx.service.forFetch(ctx.profile.id, "https://gitlab.com/team/repo"),
  ).rejects.toMatchObject({ kind: "network-failed" });

  expect(ctx.service.status(ctx.profile.id).account?.state).toBe("connected");
  ctx.fetch.mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));

  await expect(
    ctx.service.forFetch(ctx.profile.id, "https://gitlab.com/team/repo"),
  ).rejects.toMatchObject({ kind: "auth-failed" });

  expect(ctx.service.status(ctx.profile.id).account?.state).toBe("expired");
});

it("loads the signed-in GitLab account’s profile details and rejects profiles from another account", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.advance(301_000);
  expect(await ctx.service.profile(ctx.other.id)).toBeNull();

  ctx.fetch.mockResolvedValueOnce(
    json({
      id: 7,
      ...profileFields,
      avatar_url: "https://gitlab.com/uploads/-/system/user/avatar/7/photo.png",
    }),
  );

  expect(await ctx.service.profile(ctx.profile.id)).toEqual({
    id: "7",
    ...profileFields,
    avatarUrl: "https://gitlab.com/uploads/-/system/user/avatar/7/photo.png",
  });

  expect(ctx.fetch).toHaveBeenLastCalledWith(
    "https://gitlab.com/api/v4/user",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${token.access_token}` }),
      redirect: "error",
    }),
  );

  ctx.advance(301_000);

  ctx.fetch.mockResolvedValueOnce(
    json({ id: 8, avatar_url: "https://gitlab.com/uploads/-/system/user/avatar/8/photo.png" }),
  );

  expect(await ctx.service.profile(ctx.profile.id)).toEqual({
    id: "7",
    ...profileFields,
    avatarUrl: "https://gitlab.com/uploads/-/system/user/avatar/7/photo.png",
  });
});

it.each([{}, { name: 42, bio: [], location: {} }])(
  "keeps the profile usable when optional GitLab fields are missing or malformed: %j",
  async (fields) => {
    const ctx = setup();
    await ctx.connect();
    ctx.advance(301_000);
    ctx.fetch.mockResolvedValueOnce(json({ id: 7, ...fields }));

    expect(await ctx.service.profile(ctx.profile.id)).toEqual({
      id: "7",
      name: null,
      bio: null,
      location: null,
      avatarUrl: null,
    });
  },
);

it("reuses the sign-in profile across page visits, deduplicates refreshes and keeps cached metadata offline", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.fetch.mockClear();
  const cached = { id: "7", ...profileFields, avatarUrl: null };
  expect(await ctx.service.profile(ctx.profile.id)).toEqual(cached);
  expect(await ctx.service.profile(ctx.profile.id)).toEqual(cached);
  expect(ctx.fetch).not.toHaveBeenCalled();
  ctx.advance(301_000);
  const avatarUrl = "https://secure.gravatar.com/avatar/provider-selected-hash";
  ctx.fetch.mockResolvedValueOnce(json({ id: 7, ...profileFields, avatar_url: avatarUrl }));

  const values = await Promise.all([
    ctx.service.profile(ctx.profile.id),
    ctx.service.profile(ctx.profile.id),
  ]);

  expect(values).toEqual(Array(2).fill({ ...cached, avatarUrl }));
  expect(ctx.fetch).toHaveBeenCalledOnce();
  await ctx.service.profile(ctx.profile.id);
  expect(ctx.fetch).toHaveBeenCalledOnce();
  ctx.advance(301_000);
  ctx.fetch.mockRejectedValueOnce(new Error("offline"));
  expect(await ctx.service.profile(ctx.profile.id)).toEqual({ ...cached, avatarUrl });
  expect(ctx.fetch).toHaveBeenCalledTimes(2);
  await ctx.service.profile(ctx.profile.id);
  expect(ctx.fetch).toHaveBeenCalledTimes(2);
  await ctx.service.disconnect(ctx.profile.id);
  expect(await ctx.service.profile(ctx.profile.id)).toBeNull();
});

it("browses with the active profile's saved GitLab credential and refuses an unconnected profile", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.fetch.mockClear();
  ctx.fetch.mockResolvedValueOnce(json([]));

  await expect(ctx.service.repositories(ctx.profile.id)).resolves.toEqual({
    repositories: [],
    nextPage: null,
  });

  expect(ctx.fetch).toHaveBeenCalledWith(
    expect.stringContaining("https://gitlab.com/api/v4/projects?"),
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${token.access_token}` }),
    }),
  );

  ctx.fetch.mockClear();
  await expect(ctx.service.repositories(ctx.other.id)).rejects.toThrow();
  expect(ctx.fetch).not.toHaveBeenCalled();
});
