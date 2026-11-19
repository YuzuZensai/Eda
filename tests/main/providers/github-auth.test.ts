import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTEGRATIONS } from "@shared/integrations/config";
import { GitHubAuth } from "@main/providers/github-auth";
import { ProviderAccountRepository } from "@main/persistence/provider-account-repository";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import type { SecretStore } from "@main/secrets/secret-store";
import { deferred } from "../../helpers/deferred";

const databases: Database[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

const device = {
  device_code: "private-device-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

const token = {
  access_token: "gho_fixture_access",
  token_type: "bearer",
  scope: "repo",
  expires_in: 3600,
  refresh_token: "ghr_fixture_refresh",
  refresh_token_expires_in: 86400,
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function setup(path = ":memory:") {
  const db = openDatabase(path);
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
    deleteForIdentity: vi.fn(async (id) => {
      for (const key of values.keys()) if (key.startsWith(`identity:${id}:`)) values.delete(key);
    }),
  };

  const fetch = vi.fn<typeof globalThis.fetch>();
  let now = Date.now();
  const accounts = new ProviderAccountRepository(db, "github");
  const service = new GitHubAuth(accounts, secrets, fetch, () => now);

  const advance = (ms: number) => {
    now += ms;
  };

  const authorize = async () => {
    fetch
      .mockResolvedValueOnce(json(device))
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ id: 7, login: "work-user" }));

    const signIn = await service.begin(profile.id);
    advance(5000);
    await service.poll(profile.id, signIn.id);
    return signIn;
  };

  const connect = authorize;

  return {
    authorize,
    db,
    identities,
    profile,
    other,
    values,
    secrets,
    accounts,
    fetch,
    service,
    advance,
    connect,
  };
}

describe("GitHub device OAuth", () => {
  it("cancels device authorization requests that have not returned a sign-in ID", async () => {
    const ctx = setup();
    const response = deferred<Response>();
    ctx.fetch.mockReturnValueOnce(response.promise);

    const beginning = ctx.service.begin(ctx.profile.id);
    const rejected = expect(beginning).rejects.toThrow(/cancelled/i);
    ctx.service.cancelAll();
    response.resolve(json(device));

    await rejected;
    expect(ctx.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(ctx.accounts.find(ctx.profile.id)).toBeUndefined();
    expect(ctx.values.size).toBe(0);
  });

  it("does not reuse rotated refresh tokens from a delayed concurrent vault read", async () => {
    const ctx = setup();
    await ctx.connect();
    ctx.advance(3_600_000);
    const saved = [...ctx.values.values()][0];
    const delayed = deferred<string | undefined>();
    vi.mocked(ctx.secrets.get).mockResolvedValueOnce(saved).mockReturnValueOnce(delayed.promise);
    ctx.fetch.mockClear();
    ctx.fetch
      .mockResolvedValueOnce(
        json({ ...token, access_token: "gho_rotated", refresh_token: "ghr_rotated" }),
      )
      .mockResolvedValueOnce(json({ id: 7, login: "work-user" }))
      .mockResolvedValueOnce(json({ error: "bad_refresh_token" }));

    const first = ctx.service.forFetch(ctx.profile.id, "https://github.com/org/repo");
    const second = ctx.service.forFetch(ctx.profile.id, "https://github.com/org/repo");
    const result = expect(second).resolves.toEqual({
      username: "x-access-token",
      password: "gho_rotated",
    });
    await first;
    delayed.resolve(saved);

    await result;
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
    expect(ctx.service.status(ctx.profile.id).account?.state).toBe("connected");
  });

  it("loads basic public details for the durable saved account without reauthentication or leaking credentials", async () => {
    const ctx = setup();
    await ctx.connect();
    ctx.fetch.mockClear();
    vi.mocked(ctx.secrets.get).mockClear();

    ctx.fetch.mockResolvedValueOnce(
      json({
        id: 7,
        login: "renamed-user",
        name: "Work User",
        bio: "Hello\nGitHub",
        location: "Example City",
        html_url: "https://evil.invalid",
        avatar_url: "https://evil.invalid/avatar",
        email: "private@example.com",
      }),
    );

    expect(await ctx.service.profile(ctx.other.id)).toBeNull();
    const details = await ctx.service.profile(ctx.profile.id);

    expect(details).toEqual({
      id: "7",
      login: "renamed-user",
      name: "Work User",
      bio: "Hello GitHub",
      location: "Example City",
      avatarUrl: "https://evil.invalid/avatar",
    });

    expect(ctx.fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/user/7",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );

    expect(ctx.fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    expect(ctx.secrets.get).not.toHaveBeenCalled();
    expect(ctx.service.profileUrl(ctx.profile.id)).toBe("https://github.com/renamed-user");
    expect(() => ctx.service.profileUrl(ctx.other.id)).toThrow(/Connect/);
    expect(await ctx.service.profile(ctx.profile.id)).toEqual(details);
    expect(ctx.fetch).toHaveBeenCalledOnce();
    ctx.advance(301_000);
    ctx.fetch.mockRejectedValueOnce(new Error("offline"));
    expect(await ctx.service.profile(ctx.profile.id)).toEqual(details);
    expect(ctx.service.status(ctx.profile.id).account?.state).toBe("connected");
  });

  it("keeps saved account initials when public profile details belong to another account or are unavailable", async () => {
    const ctx = setup();
    await ctx.connect();
    ctx.fetch.mockResolvedValueOnce(json({ id: 8, login: "wrong-user", name: "Wrong User" }));

    expect(await ctx.service.profile(ctx.profile.id)).toEqual({
      id: "7",
      login: "work-user",
      name: null,
      bio: null,
      location: null,
      avatarUrl: null,
    });

    ctx.advance(61_000);
    ctx.fetch.mockRejectedValueOnce(new Error("offline"));
    expect((await ctx.service.profile(ctx.profile.id))?.name).toBeNull();
    expect(ctx.service.profileUrl(ctx.profile.id)).toBe("https://github.com/work-user");
  });

  it("honors polling/backoff, persists a verified profile-owned login across restart, refreshes tokens, and disconnects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eda-github-"));
    directories.push(dir);
    const ctx = setup(join(dir, "eda.db"));
    const { service, profile, other, fetch, advance, secrets, values, accounts } = ctx;
    fetch.mockResolvedValueOnce(json(device));
    const signIn = await service.begin(profile.id);
    expect(JSON.stringify(signIn)).not.toContain(device.device_code);

    expect(await service.poll(profile.id, signIn.id)).toEqual({
      state: "pending",
      intervalMs: 5000,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    advance(5000);
    fetch.mockResolvedValueOnce(json({ error: "authorization_pending" }));
    await service.poll(profile.id, signIn.id);
    advance(5000);
    fetch.mockResolvedValueOnce(json({ error: "slow_down", interval: 10 }));

    expect(await service.poll(profile.id, signIn.id)).toEqual({
      state: "pending",
      intervalMs: 10000,
    });

    advance(9999);
    await service.poll(profile.id, signIn.id);
    expect(fetch).toHaveBeenCalledTimes(3);
    advance(1);

    fetch
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ id: 7, login: "work-user" }));

    const result = await service.poll(profile.id, signIn.id);

    expect(result).toMatchObject({
      state: "connected",
      status: { account: { id: "7", state: "connected" } },
    });

    expect(service.status(other.id).account).toBeNull();
    expect(JSON.stringify([result, accounts.find(profile.id)])).not.toContain(token.access_token);
    expect(JSON.stringify(result)).not.toContain(token.refresh_token);

    for (const [, options] of fetch.mock.calls) {
      expect(options?.redirect).toBe("error");
      expect(options?.credentials).toBe("omit");
    }

    const restartedDb = openDatabase(join(dir, "eda.db"));
    databases.push(restartedDb);

    const restarted = new GitHubAuth(
      new ProviderAccountRepository(restartedDb, "github"),
      secrets,
      fetch,
      () => Date.now() + 4_000_000,
    );

    fetch
      .mockResolvedValueOnce(
        json({ ...token, access_token: "gho_refreshed", refresh_token: "ghr_rotated" }),
      )
      .mockResolvedValueOnce(json({ id: 7, login: "work-user" }));

    expect(await restarted.forFetch(profile.id, "https://github.com/org/repo.git")).toEqual({
      username: "x-access-token",
      password: "gho_refreshed",
    });

    expect(fetch.mock.calls.at(-2)?.[1]?.body).toContain("grant_type=refresh_token");
    expect([...values.values()].join()).not.toContain(token.refresh_token);
    await restarted.disconnect(profile.id);
    expect(restarted.status(profile.id).account).toBeNull();
    expect(values.size).toBe(0);
    expect(await restarted.forFetch(profile.id, "https://github.com/org/repo.git")).toBeUndefined();
  });

  it("never supplies OAuth credentials to another profile, another host, SSH, or a malformed URL", async () => {
    const ctx = setup();
    await ctx.connect();

    expect(
      await ctx.service.forFetch(ctx.other.id, "https://github.com/org/repo.git"),
    ).toBeUndefined();

    for (const url of [
      "https://github.com.evil.invalid/org/repo",
      "https://evil.invalid/github.com/repo",
      "https://github.com@evil.invalid/org/repo",
      "https://github.com/org/repo?redirect=evil",
      "https://github.com:444/org/repo",
      "http://github.com/org/repo",
      "git@github.com:org/repo.git",
      "https://github.com/org/repo/extra",
    ]) {
      expect(await ctx.service.forFetch(ctx.profile.id, url)).toBeUndefined();
    }

    const other = { ...ctx.accounts.find(ctx.profile.id)!, profileId: ctx.other.id };
    ctx.accounts.save(other);
    ctx.secrets.get = vi.fn(ctx.secrets.get);

    await expect(
      ctx.service.forFetch(ctx.other.id, "https://github.com/org/repo"),
    ).rejects.toMatchObject({ kind: "github-auth-required" });

    expect(ctx.secrets.get).not.toHaveBeenCalled();
    await ctx.service.disconnect(ctx.other.id);
    expect(ctx.values.size).toBe(1);
    ctx.identities.delete(ctx.profile.id);
    expect(ctx.accounts.find(ctx.profile.id)).toBeUndefined();
  });

  it("handles cancellation, wrong-profile polling, denial, expiry and unsafe verification URLs without saving tokens", async () => {
    const ctx = setup();
    ctx.fetch.mockResolvedValueOnce(json(device));
    let signIn = await ctx.service.begin(ctx.profile.id);
    await expect(ctx.service.poll(ctx.other.id, signIn.id)).rejects.toThrow(/another profile/);
    ctx.service.cancel(ctx.other.id, signIn.id);
    expect(ctx.service.verifyPending(ctx.profile.id, signIn.id)).toBe(signIn.userCode);
    expect(() => ctx.service.verifyPending(ctx.other.id, signIn.id)).toThrow(/another profile/);
    ctx.service.cancel(ctx.profile.id, signIn.id);
    await expect(ctx.service.poll(ctx.profile.id, signIn.id)).rejects.toThrow(/cancelled/);

    for (const error of ["access_denied", "expired_token", "device_flow_disabled"]) {
      ctx.fetch.mockResolvedValueOnce(json(device));
      signIn = await ctx.service.begin(ctx.profile.id);
      ctx.advance(5000);
      ctx.fetch.mockResolvedValueOnce(json({ error }));
      await expect(ctx.service.poll(ctx.profile.id, signIn.id)).rejects.toThrow();
    }

    ctx.fetch.mockResolvedValueOnce(json(device));
    signIn = await ctx.service.begin(ctx.profile.id);
    ctx.advance(900_001);
    await expect(ctx.service.poll(ctx.profile.id, signIn.id)).rejects.toThrow(/expired/);
    ctx.fetch.mockResolvedValueOnce(json({ ...device, verification_uri: "https://evil.invalid" }));
    await expect(ctx.service.begin(ctx.profile.id)).rejects.toThrow(/invalid device/);
    expect(ctx.values.size).toBe(0);
  });

  it("refuses unavailable secure storage, oversized/error responses and tokens from a GitHub App registration", async () => {
    const ctx = setup();

    const unavailable = new GitHubAuth(
      ctx.accounts,
      { ...ctx.secrets, available: false },
      ctx.fetch,
    );

    await expect(unavailable.begin(ctx.profile.id)).rejects.toMatchObject({
      kind: "keychain-unavailable",
    });

    const ready = setup();
    ready.fetch.mockRejectedValueOnce(new Error("secret response gho_do_not_leak"));
    await expect(ready.service.begin(ready.profile.id)).rejects.toThrow(/Could not reach GitHub/);
    ready.fetch.mockResolvedValueOnce(new Response("x".repeat(65 * 1024)));
    await expect(ready.service.begin(ready.profile.id)).rejects.toThrow(/supported size/);
    ready.fetch.mockResolvedValueOnce(json(device));
    const signIn = await ready.service.begin(ready.profile.id);
    ready.advance(5000);

    ready.fetch.mockResolvedValueOnce(
      json({ ...token, access_token: "ghu_github_app_token", scope: "repo" }),
    );

    await expect(ready.service.poll(ready.profile.id, signIn.id)).rejects.toThrow(
      /invalid access token/,
    );

    expect(ready.values.size).toBe(0);
  });

  it("preserves an existing connection if sign-in is cancelled during account verification or persistence fails", async () => {
    const ctx = setup();
    await ctx.connect();
    const saved = ctx.accounts.find(ctx.profile.id);
    ctx.fetch.mockResolvedValueOnce(json(device)).mockResolvedValueOnce(json(token));
    const signIn = await ctx.service.begin(ctx.profile.id);
    ctx.advance(5000);

    ctx.fetch.mockImplementationOnce(async () => {
      ctx.service.cancel(ctx.profile.id, signIn.id);
      return json({ id: 8, login: "another-user" });
    });

    await expect(ctx.service.poll(ctx.profile.id, signIn.id)).rejects.toThrow(/cancelled/);
    expect(ctx.accounts.find(ctx.profile.id)).toEqual(saved);
    expect(ctx.values.size).toBe(1);

    const save = vi.spyOn(ctx.accounts, "save").mockImplementation(() => {
      throw new Error("DB unavailable");
    });

    await expect(ctx.connect()).rejects.toThrow("DB unavailable");
    save.mockRestore();
    expect(ctx.accounts.find(ctx.profile.id)).toEqual(saved);
    expect(ctx.values.size).toBe(1);
  });

  it("requires reconnect for expired/revoked refresh tokens but preserves connection state on a temporary network failure", async () => {
    const ctx = setup();
    await ctx.connect();
    ctx.advance(4_000_000);
    ctx.fetch.mockRejectedValueOnce(new Error("offline"));

    await expect(
      ctx.service.forFetch(ctx.profile.id, "https://github.com/org/repo"),
    ).rejects.toMatchObject({ kind: "network-failed" });

    expect(ctx.service.status(ctx.profile.id).account?.state).toBe("connected");
    ctx.fetch.mockResolvedValueOnce(json({ error: "bad_refresh_token" }));

    await expect(
      ctx.service.forFetch(ctx.profile.id, "https://github.com/org/repo"),
    ).rejects.toMatchObject({ kind: "github-auth-required" });

    expect(ctx.service.status(ctx.profile.id).account?.state).toBe("expired");
  });
});

it("requests private repository scope and connects without any installation requests", async () => {
  const ctx = setup();
  await ctx.connect();
  const form = new URLSearchParams(String(ctx.fetch.mock.calls[0]?.[1]?.body));
  expect(form.get("scope")).toBe("repo offline_access");
  expect(form.get("client_id")).toBe(INTEGRATIONS.github.clientId);

  expect(ctx.fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://github.com/login/device/code",
    "https://github.com/login/oauth/access_token",
    "https://api.github.com/user",
  ]);

  expect(ctx.service.status(ctx.profile.id).account?.state).toBe("connected");

  expect(
    await ctx.service.forFetch(ctx.profile.id, "https://github.com/someone-else/invited.git"),
  ).toEqual({ username: "x-access-token", password: token.access_token });
});

it.each(["", "read:user", "public_repo"])(
  "rejects authorization without repo scope (%s)",
  async (scope) => {
    const ctx = setup();
    ctx.fetch.mockResolvedValueOnce(json(device)).mockResolvedValueOnce(json({ ...token, scope }));
    const signIn = await ctx.service.begin(ctx.profile.id);
    ctx.advance(5000);

    await expect(ctx.service.poll(ctx.profile.id, signIn.id)).rejects.toThrow(
      /invalid access token/,
    );

    expect(ctx.values.size).toBe(0);
    expect(ctx.accounts.find(ctx.profile.id)).toBeUndefined();
  },
);

it("supports non-expiring OAuth tokens without attempting refresh", async () => {
  const ctx = setup();

  ctx.fetch
    .mockResolvedValueOnce(json(device))
    .mockResolvedValueOnce(
      json({
        access_token: "gho_non_expiring",
        token_type: "bearer",
        scope: "repo",
      }),
    )
    .mockResolvedValueOnce(json({ id: 7, login: "work-user" }));

  const signIn = await ctx.service.begin(ctx.profile.id);
  ctx.advance(5000);
  await ctx.service.poll(ctx.profile.id, signIn.id);
  ctx.advance(40_000_000);

  expect(
    (await ctx.service.forFetch(ctx.profile.id, "https://github.com/owner/repo"))?.password,
  ).toBe("gho_non_expiring");

  expect(ctx.fetch).toHaveBeenCalledTimes(3);
});

it("discards OAuth credentials if sign-in is cancelled during a vault write", async () => {
  const ctx = setup();
  const write = ctx.secrets.set;

  ctx.secrets.set = vi.fn(async (key, value) => {
    await write(key, value);
    ctx.service.cancelProfile(ctx.profile.id);
  });

  await expect(ctx.connect()).rejects.toMatchObject({ kind: "github-auth-required" });
  expect(ctx.accounts.find(ctx.profile.id)).toBeUndefined();
  expect(ctx.values.size).toBe(0);
});

it("browses with the active profile's saved GitHub credential and refuses an unconnected profile", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.fetch.mockClear();
  ctx.fetch.mockResolvedValueOnce(json([]));

  await expect(ctx.service.repositories(ctx.profile.id)).resolves.toEqual({
    repositories: [],
    nextPage: null,
  });

  expect(ctx.fetch).toHaveBeenCalledWith(
    expect.stringContaining("https://api.github.com/user/repos?"),
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${token.access_token}` }),
    }),
  );

  ctx.fetch.mockClear();
  await expect(ctx.service.repositories(ctx.other.id)).rejects.toThrow();
  expect(ctx.fetch).not.toHaveBeenCalled();
});

it("keeps hosted provider accounts separate when they share a profile", async () => {
  const ctx = setup();
  await ctx.connect();
  const github = ctx.accounts.find(ctx.profile.id)!;
  const gitlab = new ProviderAccountRepository(ctx.db, "gitlab");

  const account = {
    ...github,
    accountId: "42",
    login: "gitlab-user",
    credentialRef: "gitlab-secret",
  };

  gitlab.save(account);
  expect(gitlab.find(ctx.profile.id)).toEqual(account);
  expect(ctx.accounts.find(ctx.profile.id)).toEqual(github);

  gitlab.delete(ctx.profile.id);
  expect(gitlab.find(ctx.profile.id)).toBeUndefined();
  expect(ctx.accounts.find(ctx.profile.id)).toEqual(github);
});

it("does not return credentials when the account disconnects during a secret read", async () => {
  const fixture = setup();
  await fixture.connect();
  let finish!: (value: string | undefined) => void;
  const saved = [...fixture.values.values()][0];
  vi.mocked(fixture.secrets.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  const credentials = fixture.service.forFetch(
    fixture.profile.id,
    "https://github.com/owner/repo.git",
  );
  const refused = expect(credentials).rejects.toMatchObject({ kind: "github-auth-required" });
  await fixture.service.disconnect(fixture.profile.id);
  finish(saved);
  await refused;
});
