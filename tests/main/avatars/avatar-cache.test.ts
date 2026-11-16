import { createHash } from "node:crypto";
import type * as FileSystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AvatarCache } from "@main/avatars/avatar-cache";
import { deferred } from "../../helpers/deferred";
const githubAvatar = "https://avatars.githubusercontent.com/u/7?v=4";
const githubNoreplyDomain = "users.noreply.github.com";

it("uses a GitHub repository's linked commit author photo for a regular email", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-github-commit-avatar-"));
  const now = 1_000_000;
  const email = "author@example.test";
  const avatarUrl = "https://avatars.githubusercontent.com/u/123?v=4";
  const fetchImage = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/"))
      return Response.json([
        {
          commit: { author: { email } },
          author: { avatar_url: avatarUrl },
        },
      ]);
    return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
  });

  try {
    const cache = new AvatarCache(directory, fetchImage, () => now);
    const first = await cache.getCommit(email, "git@github.com:team/project.git");
    const second = await cache.getCommit(email, "git@github.com:team/project.git");

    expect(first.dataUrl).toBe("data:image/png;base64,AQ==");
    expect(second).toEqual(first);
    expect(fetchImage.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/team/project/commits?author=author%40example.test&per_page=1",
      avatarUrl,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refreshes a commit avatar when the provider reports a new image URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-updated-commit-avatar-"));
  let now = 1_000_000;
  let version = 1;
  const fetchImage = vi.fn<typeof fetch>(async (input) =>
    String(input).startsWith("https://gitlab.com/api/v4/avatar?")
      ? Response.json({ avatar_url: `https://gitlab.com/uploads/avatar-${version}.png` })
      : new Response(new Uint8Array([version]), { headers: { "content-type": "image/png" } }),
  );

  try {
    const cache = new AvatarCache(directory, fetchImage, () => now);
    const first = await cache.getCommit("author@example.test", "https://gitlab.com/team/repo.git");
    expect(first.dataUrl).toBe("data:image/png;base64,AQ==");

    version = 2;
    now = first.expiresAt + 1;
    const second = await cache.getCommit("author@example.test", "https://gitlab.com/team/repo.git");
    expect(second.dataUrl).toBe("data:image/png;base64,Ag==");
    expect(fetchImage).toHaveBeenCalledTimes(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses GitLab's uploaded author photo for a GitLab repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-gitlab-commit-avatar-"));
  const avatarUrl = "https://gitlab.com/uploads/-/system/user/avatar/7/photo.png";
  const fetchImage = vi.fn<typeof fetch>(async (input) =>
    String(input).startsWith("https://gitlab.com/api/v4/avatar?")
      ? Response.json({ avatar_url: avatarUrl })
      : new Response(new Uint8Array([2]), { headers: { "content-type": "image/png" } }),
  );

  try {
    const image = await new AvatarCache(directory, fetchImage).getCommit(
      `123+author@${githubNoreplyDomain}`,
      "https://gitlab.com/team/project.git",
    );

    expect(image.dataUrl).toBe("data:image/png;base64,Ag==");
    expect(String(fetchImage.mock.calls[0]![0])).toContain(
      "https://gitlab.com/api/v4/avatar?email=123%2Bauthor%40users.noreply.github.com",
    );
    expect(String(fetchImage.mock.calls[1]![0])).toBe(avatarUrl);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses a registered self-hosted GitLab instance for commit avatars", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-self-hosted-commit-avatar-"));
  const baseUrl = "https://git.company.test/gitlab";
  const avatarUrl = "https://git.company.test/uploads/avatar/7/photo.png";
  const fetchImage = vi.fn<typeof fetch>(async (input) =>
    String(input).startsWith(`${baseUrl}/api/v4/avatar?`)
      ? Response.json({ avatar_url: avatarUrl })
      : new Response(new Uint8Array([4]), { headers: { "content-type": "image/png" } }),
  );

  try {
    const image = await new AvatarCache(directory, fetchImage).getCommit(
      "author@example.test",
      "git@git.company.test:gitlab/team/project.git",
      [baseUrl],
    );
    expect(image.dataUrl).toBe("data:image/png;base64,BA==");
    expect(String(fetchImage.mock.calls[0]![0])).toContain(`${baseUrl}/api/v4/avatar?`);
    expect(String(fetchImage.mock.calls[1]![0])).toBe(avatarUrl);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("falls back to Gravatar when the repository provider cannot identify the author", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-commit-avatar-fallback-"));
  const fetchImage = vi.fn<typeof fetch>(async (input) =>
    String(input).startsWith("https://api.github.com/")
      ? Response.json([{ commit: { author: { email: "other@example.test" } } }])
      : new Response(new Uint8Array([3]), { headers: { "content-type": "image/png" } }),
  );

  try {
    const cache = new AvatarCache(directory, fetchImage);
    const image = await cache.getCommit(
      "author@example.test",
      "https://github.com/team/project.git",
    );
    expect(image.dataUrl).toBe("data:image/png;base64,Aw==");
    expect(String(fetchImage.mock.calls[1]![0])).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\//);
    await cache.getCommit("other@example.test", "https://github.com.evil.test/repo");
    expect(String(fetchImage.mock.calls[2]![0])).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\//);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  [
    `123+Example-User@${githubNoreplyDomain}`,
    "https://avatars.githubusercontent.com/u/123?v=4&s=96",
  ],
  [`Example-User@${githubNoreplyDomain}`, "https://github.com/example-user.png?size=96"],
])("loads GitHub commit author avatars for %s before Gravatar", async (email, url) => {
  const directory = await mkdtemp(join(tmpdir(), "eda-github-author-avatar-"));
  const fetchImage = vi.fn<typeof fetch>(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  );

  try {
    const cache = new AvatarCache(directory, fetchImage);
    const image = await cache.get(email);

    expect(image.dataUrl).toBe("data:image/png;base64,AQID");
    expect(fetchImage).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({ credentials: "omit" }),
    );
    expect(await new AvatarCache(directory, fetchImage).get(email)).toEqual(image);
    expect(fetchImage).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("falls back to Gravatar when a GitHub commit author has no profile image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-github-author-fallback-"));
  const fetchImage = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([4]), { headers: { "content-type": "image/png" } }),
    );
  const email = `123+example@${githubNoreplyDomain}`;

  try {
    const image = await new AvatarCache(directory, fetchImage).get(email);

    expect(image.dataUrl).toBe("data:image/png;base64,BA==");
    expect(String(fetchImage.mock.calls[0]![0])).toContain("avatars.githubusercontent.com/u/123");
    expect(String(fetchImage.mock.calls[1]![0])).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\//);
    expect(await new AvatarCache(directory, fetchImage).get(email)).toEqual(image);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("caches GitHub avatars by durable account ID across restarts using the provider’s returned URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-github-avatar-"));
  const fetchImage = vi.fn<typeof fetch>(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  );
  try {
    const file = join(directory, "avatars");
    const cache = new AvatarCache(file, fetchImage);
    for (const invalid of ["../7", "7?redirect=evil", "https://evil.invalid", "", "0"])
      expect((await cache.getGitHub(invalid, githubAvatar)).dataUrl).toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      cache.getGitHub("7", githubAvatar),
      cache.getGitHub("7", githubAvatar),
    ]);
    expect(first).toEqual(second);
    expect(first.dataUrl).toBe("data:image/png;base64,AQID");
    expect(fetchImage).toHaveBeenCalledExactlyOnceWith(
      githubAvatar,
      expect.objectContaining({ redirect: "follow", credentials: "omit" }),
    );
    const imageFile = join(
      file,
      createHash("sha256")
        .update(`github:7:${createHash("sha256").update(githubAvatar).digest("hex")}`)
        .digest("hex"),
    );
    expect(await readFile(imageFile)).toEqual(Buffer.from([1, 2, 3]));
    expect(await readFile(join(file, "index"), "utf8")).not.toContain("base64");
    const restarted = new AvatarCache(file, fetchImage);
    expect(await restarted.getGitHub("7", githubAvatar)).toEqual(first);
    expect(fetchImage).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("deduplicates normalized authors, persists images across restarts, and refreshes expired entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-avatars-"));
  let now = 1_000_000;
  const fetchImage = vi.fn<typeof fetch>(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  );
  const file = join(directory, "avatars");

  try {
    const cache = new AvatarCache(file, fetchImage, () => now);
    const [first, second] = await Promise.all([
      cache.get(" User@Example.com "),
      cache.get("user@example.com"),
    ]);

    expect(first).toEqual(second);
    expect(first.dataUrl).toBe("data:image/png;base64,AQID");
    expect(fetchImage).toHaveBeenCalledTimes(1);

    const url = String(fetchImage.mock.calls[0]![0]);

    expect(url).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[a-f0-9]{64}\?/);
    expect(await readFile(join(file, "index"), "utf8")).not.toContain("user@example.com");

    const restarted = new AvatarCache(file, fetchImage, () => now);

    expect(await restarted.get("user@example.com")).toEqual(first);
    expect(fetchImage).toHaveBeenCalledTimes(1);

    now = first.expiresAt + 1;
    expect((await restarted.get("user@example.com")).expiresAt).toBeGreaterThan(now);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("expires missing and failed lookups and rejects oversized or non-raster responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-avatars-"));
  let now = 1_000_000;
  const fetchImage = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }))
    .mockResolvedValueOnce(
      new Response(new Uint8Array(65 * 1024), { headers: { "content-type": "image/png" } }),
    );

  try {
    const file = join(directory, "avatars");

    await mkdir(file);
    await writeFile(join(file, "index"), "invalid cache");

    const cache = new AvatarCache(file, fetchImage, () => now);
    const missing = await cache.get("user@example.com");

    expect(missing.dataUrl).toBeNull();

    await cache.get("user@example.com");
    expect(fetchImage).toHaveBeenCalledTimes(1);

    now = missing.expiresAt + 1;

    const failed = await cache.get("user@example.com");

    expect(failed.dataUrl).toBeNull();
    expect(failed.expiresAt - now).toBeLessThan(missing.expiresAt - 1_000_000);

    now = failed.expiresAt + 1;
    expect((await cache.get("user@example.com")).dataUrl).toBeNull();
    expect((await cache.get("other@example.com")).dataUrl).toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

it("coalesces concurrent distinct misses and persists every result before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-avatar-batch-"));
  const fetchImage = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
  const file = join(directory, "avatars");
  vi.mocked(rename).mockClear();
  try {
    const cache = new AvatarCache(file, fetchImage);
    const emails = ["a", "b", "c", "d"].map((name) => `${name}@example.com`);
    await Promise.all(emails.map((email) => cache.get(email)));
    expect(JSON.parse(await readFile(join(file, "index"), "utf8"))).toHaveLength(4);
    expect(vi.mocked(rename).mock.calls.length).toBeLessThanOrEqual(4);
    const restarted = new AvatarCache(file, fetchImage);
    await Promise.all(emails.map((email) => restarted.get(email)));
    expect(fetchImage).toHaveBeenCalledTimes(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("clears persisted and in-memory avatars before accepting fresh requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-avatar-reset-"));
  const fetchImage = vi.fn<typeof fetch>(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  );
  try {
    const file = join(directory, "avatars");
    const cache = new AvatarCache(file, fetchImage);
    await cache.getGitHub("7", githubAvatar);
    await cache.clear();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await cache.getGitHub("7", githubAvatar);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("clears repository author lookups before accepting fresh requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-commit-avatar-reset-"));
  const email = "author@example.test";
  const avatarUrl = "https://avatars.githubusercontent.com/u/123?v=4";
  const fetchImage = vi.fn<typeof fetch>(async (input) =>
    String(input).startsWith("https://api.github.com/")
      ? Response.json([{ commit: { author: { email } }, author: { avatar_url: avatarUrl } }])
      : new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
  );

  try {
    const cache = new AvatarCache(directory, fetchImage);
    await cache.getCommit(email, "https://github.com/team/project.git");
    await cache.clear();
    await cache.getCommit(email, "https://github.com/team/project.git");

    expect(fetchImage.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/team/project/commits?author=author%40example.test&per_page=1",
      avatarUrl,
      "https://api.github.com/repos/team/project/commits?author=author%40example.test&per_page=1",
      avatarUrl,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("waits for requests still loading the disk index before clearing the cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-avatar-loading-reset-"));
  const response = deferred<Response>();
  const fetchImage = vi.fn<typeof fetch>().mockReturnValueOnce(response.promise);
  const file = join(directory, "avatars");
  const cache = new AvatarCache(file, fetchImage);
  const image = cache.getGitHub("7", githubAvatar);
  let cleared = false;
  const clearing = cache.clear().then(() => {
    cleared = true;
  });

  try {
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledOnce());
    expect(cleared).toBe(false);
    response.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    await Promise.all([image, clearing]);
    await expect(readFile(join(file, "index"))).rejects.toMatchObject({ code: "ENOENT" });
    fetchImage.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await cache.getGitHub("7", githubAvatar)).dataUrl).toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(2);
  } finally {
    response.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    await Promise.all([image, clearing]);
    await rm(directory, { recursive: true, force: true });
  }
});

it("refetches a missing image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-avatar-missing-"));
  const file = join(directory, "avatars");
  const fetchImage = vi.fn<typeof fetch>(
    async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/webp" } }),
  );
  try {
    await new AvatarCache(file, fetchImage).getGitHub("7", githubAvatar);
    await rm(
      join(
        file,
        createHash("sha256")
          .update(`github:7:${createHash("sha256").update(githubAvatar).digest("hex")}`)
          .digest("hex"),
      ),
    );
    await new AvatarCache(file, fetchImage).getGitHub("7", githubAvatar);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("cancels an unread missing-avatar response body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-avatar-response-"));
  const cancel = vi.fn();
  const fetchImage = vi.fn<typeof fetch>(
    async () => new Response(new ReadableStream({ cancel }), { status: 404 }),
  );
  try {
    const cache = new AvatarCache(join(directory, "avatars"), fetchImage);
    expect((await cache.getGitHub("7", githubAvatar)).dataUrl).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("loads uploaded GitLab avatars from the provider, persists them, and refreshes when the avatar URL changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-gitlab-avatar-"));
  const fetchImage = vi.fn<typeof fetch>(
    async () =>
      new Response(new Uint8Array(100 * 1024), { headers: { "content-type": "image/png" } }),
  );
  const url = "https://gitlab.com/uploads/-/system/user/avatar/7/photo.png";
  try {
    const cache = new AvatarCache(directory, fetchImage);
    const first = await cache.getGitLab("7", url);
    expect(first.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(fetchImage).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({ redirect: "follow", credentials: "omit" }),
    );
    const restarted = new AvatarCache(directory, fetchImage);
    expect(await restarted.getGitLab("7", url)).toEqual(first);
    expect(fetchImage).toHaveBeenCalledOnce();
    await restarted.getGitLab("7", url.replace("photo.png", "updated.png"));
    expect(fetchImage).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects malformed or non-HTTPS provider avatar URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-provider-avatar-"));
  const fetchImage = vi.fn<typeof fetch>();
  try {
    const cache = new AvatarCache(directory, fetchImage);
    for (const url of [
      null,
      "http://gitlab.com/photo.png",
      "https://user:secret@gitlab.com/photo.png",
      "file:///photo.png",
      "not-a-url",
    ]) {
      expect((await cache.getGitLab("7", url)).dataUrl).toBeNull();
    }
    expect(fetchImage).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["github", "gitlab"] as const)(
  "caches the exact %s provider-reported avatar, including Gravatar",
  async (provider) => {
    const directory = await mkdtemp(join(tmpdir(), "eda-provider-avatar-"));
    const fetchImage = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    const url = "https://secure.gravatar.com/avatar/provider-selected-hash?s=80&d=identicon";
    try {
      const cache = new AvatarCache(directory, fetchImage);
      const get = (cache: AvatarCache) =>
        provider === "github" ? cache.getGitHub("7", url) : cache.getGitLab("7", url);
      const first = await get(cache);
      expect(first.dataUrl).toBe("data:image/png;base64,AQID");
      expect(fetchImage).toHaveBeenCalledExactlyOnceWith(
        url,
        expect.objectContaining({ credentials: "omit", redirect: "follow" }),
      );
      expect(await get(new AvatarCache(directory, fetchImage))).toEqual(first);
      expect(fetchImage).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("accepts full-size provider avatars larger than the old 256 KiB limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-full-provider-avatar-"));
  const bytes = new Uint8Array(337044);
  const fetchImage = vi.fn<typeof fetch>(
    async () => new Response(bytes, { headers: { "content-type": "image/png" } }),
  );
  try {
    const first = await new AvatarCache(directory, fetchImage).getGitHub("7", githubAvatar);
    expect(first.dataUrl).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    expect(await new AvatarCache(directory, fetchImage).getGitHub("7", githubAvatar)).toEqual(
      first,
    );
    expect(fetchImage).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("retries failed provider images after restarting instead of restoring a negative cache entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-provider-avatar-retry-"));
  const fetchImage = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
  try {
    expect(
      (await new AvatarCache(directory, fetchImage).getGitHub("7", githubAvatar)).dataUrl,
    ).toBeNull();
    expect(
      (await new AvatarCache(directory, fetchImage).getGitHub("7", githubAvatar)).dataUrl,
    ).toBe("data:image/png;base64,AQID");
    expect(fetchImage).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects provider images above the bounded 2 MiB limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-provider-avatar-limit-"));
  const fetchImage = vi.fn<typeof fetch>(
    async () =>
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
        headers: { "content-type": "image/png" },
      }),
  );
  try {
    expect(
      (await new AvatarCache(directory, fetchImage).getGitHub("7", githubAvatar)).dataUrl,
    ).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
