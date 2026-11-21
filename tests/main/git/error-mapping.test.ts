import { describe, expect, it } from "vitest";
import { gitErrorFixtures as fx, pushErrorFixtures } from "../../fixtures/git-errors";
import { mapGitError } from "@main/git/execution/error-mapping";

const map = (stderr: string, overrides: Partial<Parameters<typeof mapGitError>[0]> = {}) =>
  mapGitError({ operation: "push", exitCode: 128, stderr, ...overrides });

describe("mapGitError", () => {
  it("explains rejected tag replacement without exposing Git output or suggesting a force fetch", () => {
    const error = map(" ! [rejected] v1 -> v1 (would clobber existing tag)", {
      operation: "fetch origin",
    });
    expect(error).toMatchObject({
      kind: "non-fast-forward",
      isExpected: true,
      message: "A local tag differs from the remote tag. Eda did not overwrite it.",
      suggestedAction: "Inspect the local and remote tags before deciding which to keep.",
    });
    expect(error.toData()).not.toHaveProperty("rawStderr");
  });

  it.each(["protectedBranch", "hookRejected", "policyMentionsHistory"] as const)(
    "maps %s to an actionable server rejection before history patterns",
    (fixture) => {
      const { stderr, stdout } = pushErrorFixtures[fixture];
      const error = map(stderr, { stdout });

      expect(error).toMatchObject({
        kind: "remote-rejected",
        isExpected: true,
        message: "The remote server rejected this push.",
        suggestedAction: expect.stringContaining(
          "branch protection rules and server hook requirements",
        ),
      });
      expect(error.toData()).not.toHaveProperty("rawStderr");
    },
  );

  it.each(["nonFastForward", "fetchFirst", "staleLease"] as const)(
    "recognizes the %s porcelain reason even when stderr only reports a generic failure",
    (fixture) => {
      const { stderr, stdout } = pushErrorFixtures[fixture];
      expect(map(stderr, { stdout }).kind).toBe("non-fast-forward");
    },
  );

  it.each([pushErrorFixtures.generic.stderr, "hint: Updates were rejected by the server."])(
    "does not infer a history conflict from generic push output: %s",
    (stderr) => {
      expect(map(stderr).kind).toBe("unknown");
    },
  );

  it("distinguishes write permission failures from history conflicts", () => {
    expect(map(pushErrorFixtures.permissionDenied.stderr).kind).toBe("auth-failed");
  });

  it.each([
    "error: The branch 'feature/new' is not fully merged.",
    "error: the branch 'feature/new' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D feature/new'",
  ])("explains unmerged branch deletion without exposing Git output: %s", (stderr) => {
    const error = map(stderr, { operation: "delete branch" });

    expect(error).toMatchObject({
      kind: "invalid-input",
      message: "This branch is not fully merged.",
      suggestedAction: "Merge the branch or review its commits before deleting it.",
    });
    expect(error.toData().text?.key).toBe("main.git.errorMapping.thisBranchIsNotFullyMerged");
    expect(error.toData()).not.toHaveProperty("rawStderr");
  });

  it("explains signing failures without exposing raw signing output", () => {
    expect(map("error: gpg failed to sign the data", { operation: "commit" })).toMatchObject({
      message: "Git could not sign this change with the selected key.",
      suggestedAction: expect.stringContaining("profile"),
    });
  });

  it.each([
    ["notARepositoryMissingDir", "not-a-repository"],
    ["notARepositoryPlainDir", "not-a-repository"],
    ["noUpstream", "no-upstream"],
    ["networkUnresolvedHost", "network-failed"],
    ["badObject", "repository-corrupt"],
    ["dirtyWorkingTree", "dirty-working-tree"],
    ["lockContention", "lock-contention"],
    ["nonFastForward", "non-fast-forward"],
    ["mergeConflict", "merge-conflict"],
    ["authPublickeyDenied", "auth-failed"],
    ["authHostKeyUnverified", "auth-failed"],
  ] as const)("maps the %s fixture to %s", (fixture, kind) => {
    expect(map(fx[fixture]).kind).toBe(kind);
  });

  it("never leaks raw git output as the user-facing message", () => {
    for (const stderr of Object.values(fx)) {
      const error = map(stderr);
      expect(error.message).not.toContain("fatal:");
      expect(error.message).not.toContain("hint:");
      expect(error.message.split("\n")).toHaveLength(1);
    }
  });

  it.each([
    ["sh: git-lfs: command not found", "gitDiagnostics.lfsMissing"],
    [
      "Error downloading object: data.bin (123): Smudge error: object was not found",
      "gitDiagnostics.lfsDownload",
    ],
  ])("identifies LFS failures in Git diagnostics: %s", (stderr, key) => {
    expect(map(stderr).toData().text?.key).toBe(key);
  });

  it("keeps raw stderr for the log without exposing it in the message", () => {
    const error = map(fx.nonFastForward);
    expect(error.rawStderr).toContain("hint:");
    expect(error.toData()).not.toHaveProperty("rawStderr");
  });

  it("names the identity in an auth failure so the message is actionable", () => {
    const error = map(fx.authPublickeyDenied, { identityName: "Work" });
    expect(error.message).toBe("Authentication failed for identity Work.");
    expect(error.suggestedAction).toContain("Work");
  });

  it("distinguishes an unverified host key from a missing key", () => {
    const error = map(fx.authHostKeyUnverified, { identityName: "Work" });
    expect(error.kind).toBe("auth-failed");
    expect(error.suggestedAction).toContain("known_hosts");
  });

  it("classifies conflict and non-fast-forward as expected UI states, not crashes", () => {
    expect(map(fx.mergeConflict).isExpected).toBe(true);
    expect(map(fx.nonFastForward).isExpected).toBe(true);
    expect(map(fx.dirtyWorkingTree).isExpected).toBe(true);
  });

  it("classifies a corrupt repository as unexpected", () => {
    expect(map(fx.badObject).isExpected).toBe(false);
  });

  it("always carries an operation and a suggested action", () => {
    for (const stderr of Object.values(fx)) {
      const error = map(stderr, { operation: "fetch" });
      expect(error.operation).toBe("fetch");
      expect(error.suggestedAction).toBeTruthy();
    }
  });

  it("uses a localized fallback and keeps unrecognized output in diagnostics", () => {
    const error = map("fatal: something entirely new went wrong");
    expect(error.kind).toBe("unknown");
    expect(error.message).toBe("The push operation failed.");
    expect(error.rawStderr).toContain("something entirely new went wrong");
  });

  it("redacts credentials in unrecognized Git output before keeping or displaying diagnostics", () => {
    const error = map(
      "fatal: unexpected response from https://user:private@example.com/repo?token=private",
    );

    expect(error.kind).toBe("unknown");
    expect(error.message).toBe("The push operation failed.");
    expect(error.rawStderr).toContain("example.com/repo");
    expect(error.message).not.toContain("private");
    expect(error.rawStderr).not.toContain("private");
    expect(JSON.stringify(error.toData())).not.toContain("private");
  });

  it("does not show warning, hint or fatal output as authored error text", () => {
    const error = map(
      "Cloning into a folder...\nwarning: ignore me\nhint: me too\nfatal: the real problem",
    );
    expect(error.message).toBe("The push operation failed.");
    expect(error.rawStderr).toContain("the real problem");
  });

  it("names the repository path in a not-a-repository error", () => {
    const error = map(fx.notARepositoryPlainDir, { repositoryPath: "/home/dev/gone" });
    expect(error.message).toContain("/home/dev/gone");
  });
});
