import { afterEach, expect, it, vi } from "vitest";
import { GitLabSelfHostedAuth } from "@main/providers/gitlab-self-hosted-auth";
import { GitLabSelfHostedAccountRepository } from "@main/persistence/gitlab-self-hosted-account-repository";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { openInMemoryDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import type { SecretStore } from "@main/secrets/secret-store";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const base = "https://git.company.test/gitlab";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const profileFields = {
  name: "Work User",
  bio: "Building useful things.",
  location: "Example City",
  avatar_url: "https://git.company.test/gitlab/uploads/photo.png",
};

function setup() {
  const db = openInMemoryDatabase();
  databases.push(db);
  const identities = new IdentityRepository(db);

  const profile = identities.create({
    name: "Work",
    gitName: "Work",
    gitEmail: "work@example.com",
    hue: 210,
    signing: { format: "none", signCommits: false },
  });

  const other = identities.create({ ...profile, name: "Other" });
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

  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).endsWith("/user")
      ? json({ id: 7, username: "work.user", ...profileFields })
      : json([]),
  );

  const accounts = new GitLabSelfHostedAccountRepository(db);

  const insecure = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).endsWith("/user") ? json({ id: 7, username: "work.user" }) : json([]),
  );

  const insecureFetch = vi.fn(() => insecure);
  let now = Date.now();
  const service = new GitLabSelfHostedAuth(accounts, secrets, fetch, insecureFetch, () => now);
  const connect = (url = base, token = "glpat-private-token") =>
    service.connect(profile.id, url, token);

  return {
    db,
    identities,
    profile,
    other,
    values,
    secrets,
    fetch,
    insecure,
    insecureFetch,
    accounts,
    service,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it.each(["legacy-token", "fine-grained-token"])(
  "validates account and project access for %s without version or scope introspection",
  async (token) => {
    const ctx = setup();
    const status = await ctx.connect(base, token);

    expect(status.accounts).toEqual([
      { id: "7", login: "work.user", baseUrl: base, state: "connected", ignoreTlsErrors: false },
    ]);

    expect(ctx.fetch).toHaveBeenCalledTimes(2);

    expect(ctx.fetch).toHaveBeenNthCalledWith(
      1,
      `${base}/api/v4/user`,
      expect.objectContaining({
        redirect: "error",
        credentials: "omit",
        headers: expect.objectContaining({ "PRIVATE-TOKEN": token }),
      }),
    );

    expect(String(ctx.fetch.mock.calls[1]![0])).toContain(
      `${base}/api/v4/projects?membership=true`,
    );

    expect(JSON.stringify(ctx.accounts.list(ctx.profile.id))).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain(token);
    expect([...ctx.values.values()]).toEqual([token]);
    expect(ctx.service.profileUrl(ctx.profile.id, base)).toBe(`${base}/work.user`);
  },
);

it("caches full profiles per instance and preserves them offline without exposing credentials", async () => {
  const ctx = setup();
  await ctx.connect();
  const expected = {
    id: "7",
    baseUrl: base,
    name: profileFields.name,
    bio: profileFields.bio,
    location: profileFields.location,
    avatarUrl: profileFields.avatar_url,
  };
  ctx.fetch.mockClear();
  expect(await ctx.service.profile(ctx.profile.id, base)).toEqual(expected);
  expect(ctx.fetch).not.toHaveBeenCalled();

  const otherBase = "https://other.company.test";
  ctx.fetch.mockResolvedValueOnce(json({ id: 7, username: "other.user", name: "Other User" }));
  await ctx.connect(otherBase, "other-token");
  expect(await ctx.service.profile(ctx.profile.id, otherBase)).toMatchObject({
    name: "Other User",
    baseUrl: otherBase,
  });
  expect(await ctx.service.profile(ctx.profile.id, base)).toEqual(expected);
  await expect(ctx.service.profile(ctx.other.id, base)).rejects.toMatchObject({
    kind: "auth-failed",
  });

  ctx.advance(301_000);
  ctx.fetch.mockRejectedValueOnce(new Error("Offline"));
  expect(await ctx.service.profile(ctx.profile.id, base)).toEqual(expected);
  await ctx.service.disconnect(ctx.profile.id, base);
  await expect(ctx.service.profile(ctx.profile.id, base)).rejects.toMatchObject({
    kind: "auth-failed",
  });
});

it("loads profiles after restart using only the selected instance's TLS preference and token", async () => {
  const ctx = setup();
  await ctx.service.connect(ctx.profile.id, base, "private-token", true);
  const restarted = new GitLabSelfHostedAuth(
    ctx.accounts,
    ctx.secrets,
    ctx.fetch,
    ctx.insecureFetch,
  );
  ctx.fetch.mockClear();
  ctx.insecure.mockResolvedValueOnce(json({ id: 7, ...profileFields }));

  expect(await restarted.profile(ctx.profile.id, base)).toMatchObject({
    baseUrl: base,
    name: "Work User",
  });
  expect(ctx.fetch).not.toHaveBeenCalled();
  expect(ctx.insecure).toHaveBeenLastCalledWith(
    `${base}/api/v4/user`,
    expect.objectContaining({
      headers: expect.objectContaining({ "PRIVATE-TOKEN": "private-token" }),
    }),
  );
});

it("rejects a late profile response after the instance is disconnected", async () => {
  const ctx = setup();
  await ctx.connect();
  const restarted = new GitLabSelfHostedAuth(ctx.accounts, ctx.secrets, ctx.fetch);
  let finish!: (response: Response) => void;
  ctx.fetch.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = restarted.profile(ctx.profile.id, base);
  await vi.waitFor(() => expect(ctx.fetch).toHaveBeenCalledTimes(3));
  await restarted.disconnect(ctx.profile.id, base);
  finish(json({ id: 7, ...profileFields }));
  await expect(pending).rejects.toMatchObject({ kind: "auth-failed" });
});

it("persists separate instance credentials across service restarts and isolates profiles, hosts, and base paths", async () => {
  const ctx = setup();
  await ctx.connect();
  const second = "https://git.other.test";
  await ctx.connect(second, "other-token");
  const restarted = new GitLabSelfHostedAuth(ctx.accounts, ctx.secrets, ctx.fetch);
  expect(restarted.status(ctx.profile.id).accounts).toHaveLength(2);

  expect(await restarted.forFetch(ctx.profile.id, `${base}/group/sub/repo.git`)).toEqual({
    username: "oauth2",
    password: "glpat-private-token",
  });

  expect(await restarted.forFetch(ctx.profile.id, `${second}/group/repo.git`)).toEqual({
    username: "oauth2",
    password: "other-token",
  });

  expect(await restarted.forFetch(ctx.other.id, `${base}/group/repo.git`)).toBeUndefined();

  for (const url of [
    "https://other.company.test/gitlab/group/repo.git",
    "https://git.company.test/gitlab-other/group/repo.git",
    "https://evil.test/group/repo.git",
    "https://gitlab.com/group/repo.git",
    "git@git.company.test:group/repo.git",
  ])
    expect(await restarted.forFetch(ctx.profile.id, url)).toBeUndefined();

  await restarted.disconnect(ctx.profile.id, base);
  expect(restarted.status(ctx.profile.id).accounts).toHaveLength(1);
  expect([...ctx.values.values()]).toEqual(["other-token"]);
});

it("persists TLS preferences and uses isolated API requests only for the selected instance", async () => {
  const ctx = setup();
  ctx.fetch.mockRejectedValueOnce(new Error("Certificate rejected"));
  await expect(ctx.connect()).rejects.toMatchObject({ kind: "network-failed" });
  expect(ctx.insecureFetch).not.toHaveBeenCalled();

  await ctx.service.connect(ctx.profile.id, base, "private-token", true);
  expect(ctx.insecure).toHaveBeenCalledTimes(2);
  expect(ctx.accounts.find(ctx.profile.id, base)?.ignoreTlsErrors).toBe(true);

  const restarted = new GitLabSelfHostedAuth(
    ctx.accounts,
    ctx.secrets,
    ctx.fetch,
    ctx.insecureFetch,
  );

  expect(restarted.status(ctx.profile.id).accounts[0]?.ignoreTlsErrors).toBe(true);
  await restarted.repositories(ctx.profile.id, base);
  expect(ctx.insecure).toHaveBeenCalledTimes(3);
  expect(restarted.ignoresTlsErrors(ctx.profile.id, `${base}/group/repo.git`)).toBe(true);
  expect(restarted.ignoresTlsErrors(ctx.other.id, `${base}/group/repo.git`)).toBe(false);

  expect(
    restarted.ignoresTlsErrors(ctx.profile.id, "https://other.company.test/group/repo.git"),
  ).toBe(false);

  expect(
    restarted.ignoresTlsErrors(ctx.profile.id, "https://git.company.test/other/group/repo.git"),
  ).toBe(false);

  ctx.insecure.mockClear();
  await restarted.connect(ctx.profile.id, base, "replacement-token", false);
  await restarted.repositories(ctx.profile.id, base);
  expect(ctx.insecure).not.toHaveBeenCalled();
  expect(ctx.accounts.find(ctx.profile.id, base)?.ignoreTlsErrors).toBe(false);
  expect(restarted.ignoresTlsErrors(ctx.profile.id, `${base}/group/repo.git`)).toBe(false);
});

it("refuses credential records copied from another profile and never deletes the original secret", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.accounts.save({ ...ctx.accounts.find(ctx.profile.id, base)!, profileId: ctx.other.id });
  expect(ctx.service.status(ctx.other.id).accounts).toEqual([]);

  await expect(ctx.service.forFetch(ctx.other.id, `${base}/group/repo.git`)).rejects.toMatchObject({
    kind: "auth-failed",
  });

  await ctx.service.disconnect(ctx.other.id, base);
  expect(ctx.values.size).toBe(1);
});

it("keeps the old token when replacement validation fails", async () => {
  const ctx = setup();
  await ctx.connect();
  const saved = ctx.accounts.find(ctx.profile.id, base);
  ctx.fetch.mockResolvedValueOnce(json({ error: "must-not-echo-private-token" }, 401));
  await expect(ctx.connect(base, "bad-token")).rejects.toMatchObject({ kind: "auth-failed" });
  expect(ctx.accounts.find(ctx.profile.id, base)).toEqual(saved);
  expect([...ctx.values.values()]).toEqual(["glpat-private-token"]);
  await ctx.connect(base, "replacement-token");
  expect([...ctx.values.values()]).toEqual(["replacement-token"]);
});

it.each([401, 403, 429, 500])(
  "rejects response %s without persisting or leaking its body",
  async (status) => {
    const ctx = setup();
    ctx.fetch.mockResolvedValueOnce(json({ error: "private-response" }, status));

    await expect(ctx.connect()).rejects.toMatchObject({
      kind: status === 401 || status === 403 ? "auth-failed" : "network-failed",
    });

    expect(ctx.values.size).toBe(0);
    expect(ctx.service.status(ctx.profile.id).accounts).toEqual([]);
  },
);

it("checks repository permissions independently of the account permission", async () => {
  const ctx = setup();

  ctx.fetch
    .mockResolvedValueOnce(json({ id: 7, username: "work.user" }))
    .mockResolvedValueOnce(json({}, 403));

  await expect(ctx.connect()).rejects.toThrow(/list projects/);
  expect(ctx.values.size).toBe(0);
});

it("rejects clone URLs pointing outside the selected instance", async () => {
  const ctx = setup();

  ctx.fetch.mockResolvedValueOnce(json({ id: 7, username: "work.user" })).mockResolvedValueOnce(
    json([
      {
        id: 1,
        path_with_namespace: "group/repo",
        http_url_to_repo: "https://evil.test/group/repo.git",
        archived: false,
        visibility: "private",
      },
    ]),
  );

  await expect(ctx.connect()).rejects.toMatchObject({ kind: "network-failed" });
  expect(ctx.values.size).toBe(0);
});

it("cleans a cancelled vault write without replacing the previous connection", async () => {
  const ctx = setup();
  await ctx.connect();
  const saved = ctx.accounts.find(ctx.profile.id, base);
  const write = ctx.secrets.set;

  ctx.secrets.set = vi.fn(async (key, value) => {
    await write(key, value);
    ctx.service.cancel(ctx.profile.id);
  });

  await expect(ctx.connect(base, "replacement")).rejects.toThrow(/cancelled/);
  expect(ctx.accounts.find(ctx.profile.id, base)).toEqual(saved);
  expect([...ctx.values.values()]).toEqual(["glpat-private-token"]);
});

it("does not save an in-flight connection after a profile switch or reset", async () => {
  const ctx = setup();
  let finish!: (response: Response) => void;

  ctx.fetch.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );

  const work = ctx.connect();
  const rejection = expect(work).rejects.toThrow(/cancelled/);
  const reset = ctx.service.reset();
  finish(json({ id: 7, username: "work.user" }));
  await rejection;
  await reset;
  expect(ctx.values.size).toBe(0);
});

it("does not mark temporary or permissions failures expired, but requires reconnect after a 401", async () => {
  const ctx = setup();
  await ctx.connect();
  ctx.fetch.mockRejectedValueOnce(new Error("offline"));

  await expect(ctx.service.repositories(ctx.profile.id, base)).rejects.toMatchObject({
    kind: "network-failed",
  });

  ctx.fetch.mockResolvedValueOnce(json({}, 403));

  await expect(ctx.service.repositories(ctx.profile.id, base)).rejects.toMatchObject({
    kind: "auth-failed",
  });

  expect(ctx.service.status(ctx.profile.id).accounts[0]?.state).toBe("connected");
  ctx.fetch.mockResolvedValueOnce(json({}, 401));
  await expect(ctx.service.repositories(ctx.profile.id, base)).rejects.toThrow(/Reconnect/);
  expect(ctx.service.status(ctx.profile.id).accounts[0]?.state).toBe("expired");
});

it("refuses locked storage and ambiguous overlapping instances before sending a token", async () => {
  const ctx = setup();

  const locked = new GitLabSelfHostedAuth(
    ctx.accounts,
    { ...ctx.secrets, available: false },
    ctx.fetch,
  );

  expect(() => locked.connect(ctx.profile.id, base, "token")).toThrow(/keychain/);
  expect(ctx.fetch).not.toHaveBeenCalled();
  await ctx.connect();
  ctx.fetch.mockClear();
  expect(() => ctx.connect("https://git.company.test")).toThrow(/overlaps/);
  expect(ctx.fetch).not.toHaveBeenCalled();
});

it("bounds account responses and rejects malformed identities", async () => {
  const ctx = setup();
  ctx.fetch.mockResolvedValueOnce(new Response(" ".repeat(1024 * 1024 + 1)));
  await expect(ctx.connect()).rejects.toMatchObject({ kind: "network-failed" });
  ctx.fetch.mockResolvedValueOnce(json({ id: 7, username: "../admin" }));
  await expect(ctx.connect()).rejects.toMatchObject({ kind: "network-failed" });
  expect(ctx.values.size).toBe(0);
});
