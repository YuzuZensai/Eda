import { referenceLink } from "@shared/repository/reference-link";

describe("reference browser links", () => {
  it("strips credentials and encodes branch names without carrying query tokens", () => {
    expect(
      referenceLink(
        "https://user:secret@github.com/org/repo.git?token=secret",
        "branch",
        "feature/one",
      ),
    ).toBe("https://github.com/org/repo/tree/feature%2Fone");

    expect(referenceLink("git@gitlab.com:group/sub/repo.git", "tag", "v1")).toBe(
      "https://gitlab.com/group/sub/repo/-/tree/v1",
    );

    expect(referenceLink("ssh://git@bitbucket.org/team/repo.git", "commit", "abcd")).toBe(
      "https://bitbucket.org/team/repo/commits/abcd",
    );
  });

  it("does not guess unknown provider routes or accept executable links", () => {
    for (const url of ["javascript:alert(1)", "file:///repo", "https://unknown.example/org/repo"])
      expect(referenceLink(url, "branch", "main")).toBeNull();
  });
});

it("builds GitLab links for configured HTTPS instances, including base paths", () => {
  const base = "https://git.company.test/gitlab";
  const remote = `${base}/team/subgroup/repo.git`;

  expect(referenceLink(remote, "commit", "abc123", [base])).toBe(
    `${base}/team/subgroup/repo/-/commit/abc123`,
  );

  expect(referenceLink(remote, "branch", "feature/work", [base])).toBe(
    `${base}/team/subgroup/repo/-/tree/feature%2Fwork`,
  );

  expect(referenceLink(remote, "commit", "abc123")).toBeNull();
  expect(referenceLink(remote, "commit", "abc123", ["https://other.company.test"])).toBeNull();
});

it.each([
  ["github-enterprise", "https://github.corp.test", "/org/repo", "/org/repo/tree/feature%2Fone"],
  [
    "bitbucket-server",
    "https://git.corp.test/bitbucket",
    "/scm/proj/repo",
    "/projects/proj/repos/repo/browse?at=refs%2Fheads%2Ffeature%2Fone",
  ],
  [
    "azure",
    "https://dev.azure.com/org/My%20Project",
    "/_git/repo",
    "/_git/repo?version=GBfeature%2Fone",
  ],
] as const)(
  "routes configured %s branch links within their instance",
  (kind, base, path, route) => {
    const account = { kind, base, username: "alice" };
    expect(referenceLink(base + path + ".git", "branch", "feature/one", [], [account])).toBe(
      base + route,
    );
    expect(
      referenceLink(base + "-other" + path + ".git", "branch", "feature/one", [], [account]),
    ).toBeNull();
  },
);
