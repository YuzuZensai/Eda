import { expect, it, vi } from "vitest";
import { MemorySecrets } from "../../helpers/memory-secrets";
import { GitHosts } from "@main/providers/git-hosts";
import type { GitHostKind } from "@shared/integrations/git-host";

function userUrl(url: string) {
  const u = new URL(url);
  u.username = "account";
  return u.href;
}

it.each([
  [
    "github-enterprise",
    "https://github.example",
    "/api/v3/user/repos",
    [{ full_name: "org/r", clone_url: "https://github.example/org/r.git" }],
  ],
  [
    "bitbucket-cloud",
    "https://bitbucket.org/work",
    "api.bitbucket.org/2.0/repositories/work",
    {
      values: [
        {
          name: "r",
          links: { clone: [{ name: "https", href: userUrl("https://bitbucket.org/work/r.git") }] },
        },
      ],
    },
  ],
  [
    "bitbucket-server",
    "https://bb.example/scmhost",
    "/rest/api/1.0/repos",
    {
      isLastPage: true,
      values: [
        {
          name: "r",
          links: { clone: [{ name: "http", href: "https://bb.example/scmhost/scm/p/r.git" }] },
        },
      ],
    },
  ],
  [
    "azure",
    "https://dev.azure.com/work/proj",
    "/proj/_apis/git/repositories",
    { value: [{ name: "r", remoteUrl: userUrl("https://dev.azure.com/work/proj/_git/r") }] },
  ],
] as const)(
  "discovers %s repositories and scopes Git credentials to the connected profile and HTTPS base",
  async (kind, base, api, response) => {
    const request = vi.fn(async () => new Response(JSON.stringify(response)));
    const hosts = new GitHosts(new MemorySecrets(), request);
    await hosts.connect(
      "work",
      { kind: kind as GitHostKind, base, username: "person@example.test" },
      "private-token",
    );
    expect(request.mock.calls[0]).toEqual([
      expect.stringContaining(api),
      expect.objectContaining({ redirect: "error" }),
    ]);
    const { entries } = await hosts.repositories("work", base, 0);
    expect(entries).toHaveLength(1);
    expect(new URL(entries[0]!.url).username).toBe("");
    expect(await hosts.forFetch("work", entries[0]!.url)).toMatchObject({
      password: "private-token",
    });
    expect(await hosts.forFetch("personal", entries[0]!.url)).toBeUndefined();
    expect(await hosts.forFetch("work", "https://other.example/secret")).toBeUndefined();
    expect(JSON.stringify(await hosts.accounts("work"))).not.toContain("private-token");
    if (kind === "bitbucket-cloud") {
      const endpoint = "https://api.bitbucket.org/2.0/repositories/work";
      request.mockResolvedValueOnce(
        new Response(JSON.stringify({ ...response, next: endpoint + "?after=opaque-cursor" })),
      );
      const first = await hosts.repositories("work", base, 0);
      expect(first.next).toBe("?after=opaque-cursor");
      await hosts.repositories("work", base, first.next!);
      expect(request).toHaveBeenLastCalledWith(
        endpoint + "?after=opaque-cursor",
        expect.objectContaining({ redirect: "error" }),
      );
      request.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...response,
            next: "https://other.example/2.0/repositories/work?page=2",
          }),
        ),
      );
      await expect(hosts.repositories("work", base, 0)).rejects.toThrow();
    }
    await hosts.disconnect("work", base);
    expect(await hosts.forFetch("work", entries[0]!.url)).toBeUndefined();
  },
);
