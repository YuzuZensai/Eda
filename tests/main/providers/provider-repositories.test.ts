import { listProviderRepositories } from "@main/providers/provider-repositories";

const githubRepository = {
  id: 42,
  full_name: "team/eda",
  clone_url: "https://github.com/team/eda.git",
  description: "A Git client",
  private: true,
  archived: false,
};

it("lists authenticated GitHub repositories and exposes only clone metadata with pagination", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify([githubRepository]), {
      headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
    }),
  );
  const result = await listProviderRepositories(fetch, "github", "private-token", 1);
  expect(result).toEqual({
    repositories: [
      {
        id: "42",
        name: "eda",
        fullName: "team/eda",
        description: "A Git client",
        cloneUrl: githubRepository.clone_url,
        private: true,
        archived: false,
        updatedAt: null,
      },
    ],
    nextPage: 2,
  });
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("https://api.github.com/user/repos?"),
    expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer private-token" }),
    }),
  );
  expect(JSON.stringify(result)).not.toContain("private-token");
});

it("lists GitLab membership projects and normalizes nested groups and visibility", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(
      JSON.stringify([
        {
          id: 7,
          path_with_namespace: "team/subgroup/eda",
          http_url_to_repo: "https://gitlab.com/team/subgroup/eda.git",
          visibility: "internal",
          archived: true,
        },
      ]),
      { headers: { "x-next-page": "4" } },
    ),
  );
  const result = await listProviderRepositories(fetch, "gitlab", "private-token", 3);
  expect(result).toMatchObject({
    repositories: [{ name: "eda", fullName: "team/subgroup/eda", private: true, archived: true }],
    nextPage: 4,
  });
  expect(fetch.mock.calls[0]![0]).toContain("membership=true");
  expect(fetch.mock.calls[0]![0]).toContain("page=3");
});

it.each([
  "https://evil.test/team/eda.git",
  "https://token@github.com/team/eda.git",
  "https://github.com/team/eda.git?secret=value",
])("rejects unsafe clone URLs: %s", async (clone_url) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(JSON.stringify([{ ...githubRepository, clone_url }])));
  await expect(listProviderRepositories(fetch, "github", "token", 1)).rejects.toMatchObject({
    kind: "network-failed",
  });
});

it.each([401, 403, 429, 500])(
  "reports provider failure %s without exposing response content or tokens",
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("sensitive-response", { status }));
    await expect(
      listProviderRepositories(fetch, "github", "private-token", 1),
    ).rejects.toMatchObject({
      kind: status === 401 || status === 403 ? "auth-failed" : "network-failed",
    });
  },
);

it("rejects oversized responses and invalid pages", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(" ".repeat(4 * 1024 * 1024 + 1)));
  await expect(listProviderRepositories(fetch, "github", "token", 1)).rejects.toMatchObject({
    kind: "network-failed",
  });
  fetch.mockClear();
  await expect(listProviderRepositories(fetch, "github", "token", -1)).rejects.toMatchObject({
    kind: "invalid-input",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("revalidates cached pages within an account and drops them after access is revoked", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const page = () =>
    new Response(JSON.stringify([githubRepository]), { headers: { etag: '"one"' } });
  const load = (owner: string, token: string) =>
    listProviderRepositories(fetch, "github", token, 1, undefined, owner);
  fetch.mockResolvedValueOnce(page());
  const first = await load("p1", "token");
  fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
  await expect(load("p1", "token")).resolves.toEqual(first);
  expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get("if-none-match")).toBe('"one"');
  for (const [owner, token] of [
    ["p2", "token"],
    ["p1", "new"],
  ] as const) {
    fetch.mockResolvedValueOnce(page());
    await load(owner, token);
    expect(new Headers(fetch.mock.lastCall?.[1]?.headers).has("if-none-match")).toBe(false);
  }
  fetch.mockResolvedValueOnce(
    new Response(null, { status: 403, headers: { "x-github-sso": "required" } }),
  );
  await expect(load("p1", "token")).rejects.toThrow(/single sign-on/);
  fetch.mockResolvedValueOnce(
    new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
  );
  await expect(load("p1", "token")).rejects.toThrow(/rate limit/);
  expect(new Headers(fetch.mock.lastCall?.[1]?.headers).has("if-none-match")).toBe(false);
});
