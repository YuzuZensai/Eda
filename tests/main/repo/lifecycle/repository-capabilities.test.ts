import { afterEach, expect, it, vi } from "vitest";
import { access } from "node:fs/promises";
import { repositoryCapabilities } from "@main/repo/lifecycle/repository-capabilities";
import type { GitService } from "@main/git/git-service";

vi.mock("node:fs/promises", () => ({ access: vi.fn(), constants: { W_OK: 2 } }));

const git = {
  exec: vi.fn(async () => ({ stdout: "C:/repo/.git\nC:/repo/.git\nfalse\nsha1\n" })),
} as unknown as GitService;

afterEach(() => vi.resetAllMocks());

it("permits an unborn repository without an index", async () => {
  vi.mocked(access).mockImplementation(async (path) => {
    if (String(path).endsWith("index"))
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  expect(await repositoryCapabilities(git, "C:/repo")).toEqual({
    write: true,
    shallow: false,
    objectFormat: "sha1",
  });
});

it("keeps inspection available while explaining denied metadata writes", async () => {
  vi.mocked(access).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  expect(await repositoryCapabilities(git, "C:/repo")).toEqual({
    write: false,
    shallow: false,
    objectFormat: "sha1",
    reason: expect.stringContaining("read-only"),
  });
});
