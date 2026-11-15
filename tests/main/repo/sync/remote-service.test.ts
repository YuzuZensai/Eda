import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { errorFixture } from "../../../helpers/error";
import { GitError } from "@shared/errors";
import { FetchHistoryRepository } from "@main/persistence/fetch-history-repository";
import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { OperationRepository } from "@main/persistence/operation-repository";
import { OperationManager } from "@main/operations/operation-manager";
import { IdentityManager } from "@main/identity/identity-manager";
import { RepositoryManager } from "@main/repo/lifecycle/repository-manager";
import { RepositoryWriter } from "@main/repo/working-tree/repository-writer";
import { RemoteService } from "@main/repo/sync/remote-service";
import { PullService } from "@main/repo/sync/pull-service";
import { RebaseService } from "@main/repo/workflows/rebase-service";
import { WorkflowService } from "@main/repo/workflows/workflow-service";
import { WorkflowJournal } from "@main/persistence/workflow-journal";
import { ContentRecoveryRepository } from "@main/persistence/content-recovery-repository";
import { SettingsRepository } from "@main/persistence/settings-repository";
import { ProfileSessionRepository } from "@main/persistence/profile-session-repository";
import { BackgroundFetchService } from "@main/repo/sync/background-fetch-service";
import type { Database } from "@main/persistence/types";
import type { GitLabAuth } from "@main/providers/gitlab-auth";
import type { GitLabSelfHostedAuth } from "@main/providers/gitlab-self-hosted-auth";
import { isGitLabHttps } from "@shared/integrations/gitlab";
import type { GitHubAuth } from "@main/providers/github-auth";
import { isGitHubHttps } from "@shared/integrations/github";

const fixtures: TempRepo[] = [];
const databases: Database[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const repo of fixtures.splice(0)) await repo.cleanup();
});

async function setup(
  github?: Pick<GitHubAuth, "forFetch">,
  gitlab?: Pick<GitLabAuth, "forFetch">,
  gitlabSelfHosted?: Pick<GitLabSelfHostedAuth, "forFetch" | "ignoresTlsErrors">,
) {
  const server = await createTempRepo({ bare: true });

  fixtures.push(server);

  const source = await createTempRepo();

  fixtures.push(source);
  await source.writeFile("file.txt", "initial\n");
  await source.commit("initial");
  await source.run(["remote", "add", "origin", server.path]);
  await source.run(["push", "origin", "main"]);

  const db = openInMemoryDatabase();

  databases.push(db);

  const identities = new IdentityRepository(db);

  const profile = identities.create({
    name: "Work",
    gitName: "Eda",
    gitEmail: "test@eda.invalid",
    hue: 210,
    signing: { format: "none", signCommits: false },
    rules: [],
  });

  identities.setActiveId(profile.id);

  const identity = new IdentityManager(identities, source.git);
  const repositories = new RepositoryManager(
    new RepositoryMemberships(db),
    source.git,
    identity,
    identities,
  );
  const operations = new OperationManager(new OperationRepository(db));
  const writer = new RepositoryWriter(source.git, repositories, identity, identities, operations);

  const service = new RemoteService(
    source.git,
    repositories,
    writer,
    identity,
    identities,
    operations,
    new FetchHistoryRepository(db),
    github,
    gitlab,
    gitlabSelfHosted,
  );

  const client = await service.clone({
    profileId: profile.id,
    url: server.path,
    parent: source.home,
    name: "client with spaces",
  });

  const run = (args: string[]) => source.run(args, client.path);
  const journal = new WorkflowJournal(db);
  const recovery = new ContentRecoveryRepository(db);

  const workflows = new WorkflowService(
    source.git,
    repositories,
    writer,
    identity,
    journal,
    recovery,
  );

  const rebase = new RebaseService(
    source.git,
    repositories,
    writer,
    identity,
    workflows,
    journal,
    recovery,
  );

  const pull = new PullService(
    source.git,
    repositories,
    writer,
    service,
    workflows,
    rebase,
    new SettingsRepository(db),
  );

  return {
    service,
    writer,
    source,
    server,
    client,
    run,
    profile,
    identities,
    operations,
    pull,
    workflows,
    rebase,
    identity,
    repositories,
    db,
  };
}

it("uses origin for commit avatars and switches to another remote after origin is removed", async () => {
  const { service, client, server } = await setup();

  expect(await service.primaryFetchUrl(client.id)).toBe(server.path);
  await service.change(client.id, {
    kind: "url",
    name: "origin",
    url: "https://github.com/team/project.git",
    push: false,
  });
  expect(await service.primaryFetchUrl(client.id)).toBe("https://github.com/team/project.git");

  await service.change(client.id, { kind: "remove", name: "origin" });
  await service.change(client.id, {
    kind: "add",
    name: "backup",
    url: "https://gitlab.com/team/project.git",
  });
  expect(await service.primaryFetchUrl(client.id)).toBe("https://gitlab.com/team/project.git");
});

it("schedules only open repositories, pauses when offline or suspended, backs off failures and refreshes refs without changing local work", async () => {
  const { service, source, server, client, run, profile, identity, repositories, db, identities } =
    await setup();
  const sessions = new ProfileSessionRepository(db);
  const settings = new SettingsRepository(db);
  let now = Date.now();
  let conditions = { online: true, suspended: false };
  const changed: string[] = [];

  const scheduler = new BackgroundFetchService(
    identity,
    sessions,
    settings,
    repositories,
    service,
    () => conditions,
    (id) => changed.push(id),
    () => now,
  );

  scheduler.configure(client.id, 1);
  await source.writeFile("scheduled.txt", "remote update\n");
  await source.commit("scheduled update");
  await source.run(["push", "origin", "main"]);

  const original = await run(["rev-parse", "HEAD"]);

  await writeFile(join(client.path, "local.txt"), "keep local work\n");
  await scheduler.tick();
  expect(await run(["rev-parse", "origin/main"])).toBe(original);

  sessions.change(profile.id, "main", {
    kind: "tabs",
    tabs: [client.id],
    selectedRepositoryId: client.id,
  });

  const inspections = vi.spyOn(service, "fetchStates");
  scheduler.configure(client.id, 0);
  await scheduler.tick();
  expect(inspections).not.toHaveBeenCalled();
  scheduler.configure(client.id, 1);
  conditions = { online: false, suspended: false };
  await scheduler.tick();
  expect(inspections).not.toHaveBeenCalled();
  expect((await scheduler.inspect(client.id)).remotes[0]!.history).toBeNull();

  conditions = { online: true, suspended: false };
  await scheduler.tick();
  expect(await run(["rev-parse", "origin/main"])).toBe(await source.run(["rev-parse", "HEAD"]));
  expect(await run(["rev-parse", "HEAD"])).toBe(original);
  expect(await readFile(join(client.path, "local.txt"), "utf8")).toBe("keep local work\n");

  const success = (await scheduler.inspect(client.id)).remotes[0]!.history!;

  expect(success.lastSuccess).not.toBeNull();

  await scheduler.tick();
  expect(changed).toEqual([client.id]);

  const unavailable = join(source.home, "temporarily-unavailable.git");

  await service.change(client.id, { kind: "url", name: "origin", url: unavailable, push: false });
  await scheduler.tick();

  const failed = (await scheduler.inspect(client.id)).remotes[0]!.history!;

  expect(failed.failures).toBe(1);
  expect(failed.error).toBeTruthy();
  expect(failed.retryAt).toBeGreaterThan(failed.lastAttempt);

  await scheduler.tick();
  expect((await scheduler.inspect(client.id)).remotes[0]!.history).toEqual(failed);

  const restarted = new BackgroundFetchService(
    identity,
    sessions,
    settings,
    repositories,
    service,
    () => conditions,
    (id) => changed.push(id),
    () => now,
  );

  expect((await restarted.inspect(client.id)).remotes[0]!.history).toEqual(failed);

  await source.run(["clone", "--bare", server.path, unavailable]);
  now = failed.retryAt! + 1;
  conditions.suspended = true;
  await restarted.tick();
  expect((await restarted.inspect(client.id)).remotes[0]!.history).toEqual(failed);

  conditions.suspended = false;
  identities.setActiveId(null);
  await restarted.tick();
  identities.setActiveId(profile.id);
  expect((await restarted.inspect(client.id)).remotes[0]!.history).toEqual(failed);

  await restarted.tick();

  expect((await restarted.inspect(client.id)).remotes[0]!.history).toMatchObject({
    failures: 0,
    error: null,
    retryAt: null,
  });

  expect(await run(["rev-parse", "HEAD"])).toBe(original);

  scheduler.stop();
  restarted.stop();
}, 60_000);

it("pulls a pinned upstream with fast-forward and rebase policies while preserving merge recovery and scoped defaults", async () => {
  const { source, client, run, pull, workflows, rebase, service } = await setup();

  expect(pull.preference(client.id).value).toBe("ff");

  pull.setPreference(client.id, "ff-only");

  expect(pull.preference(client.id)).toMatchObject({
    value: "ff-only",
    source: { kind: "repository" },
  });

  pull.setPreference(client.id, null);
  expect(pull.preference(client.id).value).toBe("ff");

  await source.writeFile("remote.txt", "remote addition\n");
  await source.commit("remote addition");
  await source.run(["push", "origin", "main"]);

  const forward = await pull.prepare({ repositoryId: client.id, strategy: "ff-only" });

  expect(forward).toMatchObject({
    ahead: 0,
    behind: 1,
    branch: "main",
    upstream: "refs/remotes/origin/main",
  });

  expect(await pull.execute(client.id, forward.token)).toBe("Pull completed.");
  expect((await run(["rev-parse", "HEAD"])).trim()).toBe(forward.source);

  await writeFile(join(client.path, "file.txt"), "client change\n");
  await run(["add", "file.txt"]);
  await run(["commit", "-m", "client change"]);

  const original = (await run(["rev-parse", "HEAD"])).trim();

  await source.writeFile("file.txt", "remote change\n");
  await source.commit("remote change");
  await source.run(["push", "origin", "main"]);

  const divergent = await pull.prepare({ repositoryId: client.id, strategy: "ff-only" });

  expect(divergent).toMatchObject({ ahead: 1, behind: 1 });
  expect(divergent.blockedReason).toMatch(/diverged/);
  expect(() => pull.execute(client.id, divergent.token)).toThrow(/diverged/);
  expect((await run(["rev-parse", "HEAD"])).trim()).toBe(original);

  const merge = await pull.prepare({ repositoryId: client.id, strategy: "ff" });

  expect(merge).toMatchObject({ ahead: 1, behind: 1 });
  expect(await pull.execute(client.id, merge.token)).toMatch(/Resolve conflicts/);

  const abort = await workflows.prepareAbort(client.id);

  await workflows.abortMerge(client.id, abort.token);
  expect((await run(["rev-parse", "HEAD"])).trim()).toBe(original);

  const replay = await pull.prepare({ repositoryId: client.id, strategy: "rebase" });

  expect(await pull.execute(client.id, replay.token)).toMatch(/abort the rebase/);

  await writeFile(join(client.path, "file.txt"), "combined change\n");
  await run(["add", "file.txt"]);

  const continuation = await rebase.prepare(client.id, "continue");

  await rebase.execute(client.id, continuation.token);
  expect((await run(["rev-parse", "HEAD^"])).trim()).toBe(replay.source);
  expect(await run(["status", "--porcelain"])).toBe("");

  const push = await service.preparePush({
    repositoryId: client.id,
    remote: "origin",
    branch: "main",
    destination: "main",
    setUpstream: false,
    mode: "normal",
  });

  await service.push(client.id, push.token);

  expect((await source.run(["ls-remote", "origin", "refs/heads/main"])).split("\t")[0]).toBe(
    (await run(["rev-parse", "HEAD"])).trim(),
  );
}, 60_000);

it.each([true, false])(
  "refreshes all upstream remote branches during pull and respects pruning (prune: %s)",
  async (prune) => {
    const { service, source, client, run, pull, db, profile } = await setup();
    if (!prune)
      new SettingsRepository(db).set(
        "fetchPrune",
        { kind: "repository", profileId: profile.id, repositoryId: client.id },
        false,
      );

    await source.run(["push", "origin", "main:obsolete"]);
    await service.fetch({ repositoryId: client.id, remote: "origin", prune: false, tags: false });
    await run(["branch", "obsolete", "origin/obsolete"]);
    await run(["tag", "local-tag"]);
    const head = await run(["rev-parse", "HEAD"]);
    const index = await run(["ls-files", "--stage", "-z"]);
    await writeFile(join(client.path, "file.txt"), "local work\n");
    await source.run(["push", "origin", "--delete", "obsolete"]);
    await source.run(["push", "origin", "main:new-branch"]);
    await source.writeFile("remote.txt", "remote update\n");
    await source.commit("remote update");
    await source.run(["push", "origin", "main"]);

    const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff-only" });
    const branches = (await service.inspect(client.id)).branches.map((branch) => branch.name);

    expect(branches.includes("origin/obsolete")).toBe(!prune);
    expect(branches).toContain("origin/new-branch");
    expect(branches).toContain("obsolete");
    expect(preview.source).toBe((await source.run(["rev-parse", "HEAD"])).trim());
    expect(preview.behind).toBe(1);
    expect(await run(["rev-parse", "HEAD"])).toBe(head);
    expect(await run(["ls-files", "--stage", "-z"])).toBe(index);
    expect(await run(["tag", "--list"])).toBe("local-tag\n");
    expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("local work\n");
    expect(await pull.execute(client.id, preview.token)).toBe("Pull completed.");
    expect((await run(["rev-parse", "HEAD"])).trim()).toBe(preview.source);
    expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("local work\n");
  },
);

it("rejects pulling a deleted upstream instead of merging its stale tracking ref", async () => {
  const { service, source, client, run, pull } = await setup();
  await source.run(["push", "origin", "main:obsolete"]);
  await service.fetch({ repositoryId: client.id, remote: "origin", prune: false, tags: false });
  await service.track(client.id, "main", "refs/remotes/origin/obsolete");
  await source.run(["push", "origin", "--delete", "obsolete"]);
  const head = await run(["rev-parse", "HEAD"]);

  await expect(
    pull.prepare({ repositoryId: client.id, strategy: "ff-only" }),
  ).rejects.toMatchObject({ rawStderr: expect.stringContaining("couldn't find remote ref") });
  expect(await run(["rev-parse", "HEAD"])).toBe(head);
});

it.each(["scheduled", "retry"] as const)(
  "prunes deleted remote branches on %s background fetch while preserving local work",
  async (mode) => {
    const { service, source, client, run, profile, identity, repositories, db } = await setup();
    await source.run(["push", "origin", "main:obsolete"]);
    await service.fetch({ repositoryId: client.id, remote: "origin", prune: false, tags: false });
    await run(["branch", "obsolete", "origin/obsolete"]);
    await source.run(["push", "origin", "--delete", "obsolete"]);
    await writeFile(join(client.path, "file.txt"), "local work\n");
    const head = await run(["rev-parse", "HEAD"]);
    const sessions = new ProfileSessionRepository(db);
    const settings = new SettingsRepository(db);
    const changed = vi.fn();
    const scheduler = new BackgroundFetchService(
      identity,
      sessions,
      settings,
      repositories,
      service,
      () => ({ online: true, suspended: false }),
      changed,
      () => Date.now() + 10 * 60_000,
    );
    sessions.change(profile.id, "main", {
      kind: "tabs",
      tabs: [client.id],
      selectedRepositoryId: client.id,
    });
    const scope = { kind: "repository", profileId: profile.id, repositoryId: client.id } as const;
    const fetch = () =>
      mode === "scheduled" ? scheduler.tick() : scheduler.retry(client.id, "origin");

    settings.set("fetchPrune", scope, false);
    await fetch();
    expect((await service.inspect(client.id)).branches.map((branch) => branch.name)).toContain(
      "origin/obsolete",
    );

    settings.reset("fetchPrune", scope);
    await fetch();
    const branches = (await service.inspect(client.id)).branches.map((branch) => branch.name);
    expect(branches).not.toContain("origin/obsolete");
    expect(branches).toContain("obsolete");
    expect(await run(["rev-parse", "HEAD"])).toBe(head);
    expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("local work\n");
    expect(changed).toHaveBeenCalledWith(client.id);
    await scheduler.stop();
  },
);

it("clones, configures multiple remotes, fetches/prunes and changes tracking without altering local work", async () => {
  const { service, source, server, client, run } = await setup();

  await service.change(client.id, { kind: "add", name: "secondary", url: server.path });
  await service.change(client.id, { kind: "rename", name: "secondary", to: "backup" });
  await service.change(client.id, { kind: "url", name: "backup", url: server.path, push: true });

  expect((await service.inspect(client.id)).remotes.map((item) => item.name)).toEqual([
    "backup",
    "origin",
  ]);

  await source.run(["branch", "topic"]);
  await source.run(["push", "origin", "topic"]);
  await writeFile(join(client.path, "file.txt"), "unsaved working bytes\n");

  const head = await run(["rev-parse", "HEAD"]);
  const index = await run(["ls-files", "--stage", "-z"]);

  await service.fetch({ repositoryId: client.id, remote: null, prune: true, tags: false });
  await service.track(client.id, "main", "refs/remotes/backup/topic");

  expect(
    (await service.inspect(client.id)).branches.find((item) => item.name === "main")?.upstream,
  ).toBe("backup/topic");

  await source.run(["push", "origin", "--delete", "topic"]);
  await service.fetch({ repositoryId: client.id, remote: "backup", prune: true, tags: false });

  expect(
    (await service.inspect(client.id)).branches.find((item) => item.name === "main")?.upstreamState,
  ).toBe("[gone]");

  await service.track(client.id, "main", null);

  expect(
    (await service.inspect(client.id)).branches.find((item) => item.name === "main")?.upstream,
  ).toBeUndefined();

  await service.change(client.id, { kind: "remove", name: "backup" });
  expect((await service.inspect(client.id)).remotes.map((item) => item.name)).toEqual(["origin"]);
  expect(await run(["rev-parse", "HEAD"])).toBe(head);
  expect(await run(["ls-files", "--stage", "-z"])).toBe(index);
  expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("unsaved working bytes\n");
});

it("publishes selected branches, rejects stale leases even after fetch, and permits a newly reviewed rewrite", async () => {
  const { service, source, server, client, run, operations, profile } = await setup();

  await run(["checkout", "-b", "feature"]);
  await writeFile(join(client.path, "local.txt"), "local\n");
  await run(["add", "."]);
  await run(["commit", "-m", "local change"]);

  const request = {
    repositoryId: client.id,
    remote: "origin",
    branch: "feature",
    destination: "published",
    setUpstream: true,
    mode: "normal" as const,
  };

  const first = await service.preparePush(request);

  expect(first.remoteOid).toBeNull();

  await service.push(client.id, first.token);
  expect((await run(["rev-parse", "feature@{upstream}"])).trim()).toBe(first.localOid);

  const lease = await service.preparePush({ ...request, mode: "lease" });

  await source.writeFile("other.txt", "someone else's work\n");
  await source.commit("other author");
  await source.run(["push", "origin", "main:published", "--force"]);

  const newer = await server.run(["rev-parse", "refs/heads/published"]);

  await service.fetch({ repositoryId: client.id, remote: "origin", prune: false, tags: false });

  await expect(service.push(client.id, lease.token)).rejects.toMatchObject({
    kind: "non-fast-forward",
  });

  expect(await server.run(["rev-parse", "refs/heads/published"])).toBe(newer);

  const normal = await service.preparePush(request);

  await expect(service.push(client.id, normal.token)).rejects.toMatchObject({
    kind: "non-fast-forward",
  });

  const reviewed = await service.preparePush({ ...request, mode: "lease" });

  await service.push(client.id, reviewed.token);
  expect((await server.run(["rev-parse", "refs/heads/published"])).trim()).toBe(first.localOid);
  await expect(async () => service.push(client.id, reviewed.token)).rejects.toThrow(/expired/);

  expect(
    operations
      .list(profile.id)
      .some((record) => record.kind === "Push branch" && record.state === "failed"),
  ).toBe(true);
});

it("rejects changed sources and profile ownership at push confirmation, and preserves occupied clone destinations", async () => {
  const { service, source, server, client, run, profile, identities } = await setup();

  const request = {
    repositoryId: client.id,
    remote: "origin",
    branch: "main",
    destination: "main",
    setUpstream: false,
    mode: "normal" as const,
  };

  const preview = await service.preparePush(request);

  await run(["commit", "--allow-empty", "-m", "changed after preview"]);
  await expect(service.push(client.id, preview.token)).rejects.toThrow(/changed after preview/);

  const owned = await service.preparePush(request);

  const other = identities.create({
    name: "Home",
    gitName: "Home",
    gitEmail: "home@example.com",
    hue: 20,
    signing: { format: "none", signCommits: false },
    rules: [],
  });

  identities.setActiveId(other.id);
  await expect(async () => service.push(client.id, owned.token)).rejects.toThrow();

  identities.setActiveId(profile.id);

  const occupied = join(source.home, "occupied");

  await mkdir(occupied);
  await writeFile(join(occupied, "keep.txt"), "keep");

  await expect(
    service.clone({
      profileId: profile.id,
      url: server.path,
      parent: source.home,
      name: "occupied",
    }),
  ).rejects.toThrow(/already exists/);

  expect(await readFile(join(occupied, "keep.txt"), "utf8")).toBe("keep");
});

it("rejects executable transports and embedded credentials before changing remote configuration", async () => {
  const { service, client } = await setup();

  for (const url of [
    "ext::command",
    "https://user:token@host/repo",
    "https://host/repo?token=secret",
    "-evil",
  ])
    await expect(
      service.change(client.id, { kind: "add", name: "unsafe", url }),
    ).rejects.toMatchObject({ kind: "invalid-input" });

  expect((await service.inspect(client.id)).remotes.map((item) => item.name)).toEqual(["origin"]);
});

it("pushes selected tags and deletes only reviewed remote refs, retaining local refs and rejecting changed deletion targets", async () => {
  const { service, source, server, client, run } = await setup();

  await run(["tag", "-a", "release", "-m", "release notes"]);
  await run(["tag", "private-tag"]);

  const request = {
    repositoryId: client.id,
    remote: "origin",
    branch: "release",
    destination: "release",
    refKind: "tag" as const,
    setUpstream: false,
    mode: "normal" as const,
  };

  const tag = await service.preparePush(request);

  await service.push(client.id, tag.token);
  expect((await server.run(["rev-parse", "refs/tags/release"])).trim()).toBe(tag.localOid);
  expect(await server.run(["tag", "--list", "private-tag"])).toBe("");

  const removal = await service.preparePush({ ...request, mode: "delete" });

  await source.run(["tag", "-a", "replacement", "-m", "replacement"]);
  await source.run(["push", "origin", "+refs/tags/replacement:refs/tags/release"]);

  await expect(service.push(client.id, removal.token)).rejects.toMatchObject({
    kind: "non-fast-forward",
  });

  const refreshed = await service.preparePush({ ...request, mode: "delete" });

  await service.push(client.id, refreshed.token);
  expect(await server.run(["tag", "--list", "release"])).toBe("");
  expect((await run(["rev-parse", "refs/tags/release"])).trim()).toBe(tag.localOid);

  const branch = {
    ...request,
    refKind: "branch" as const,
    branch: "main",
    destination: "published",
  };

  await service.push(client.id, (await service.preparePush(branch)).token);

  const before = await run(["show-ref"]);

  await service.push(client.id, (await service.preparePush({ ...branch, mode: "delete" })).token);
  expect(await server.run(["branch", "--list", "published"])).toBe("");

  expect(await run(["show-ref", "--heads", "--tags"])).toBe(
    before
      .split("\n")
      .filter((line) => / refs\/(heads|tags)\//.test(line))
      .join("\n") + "\n",
  );

  const force = await service.preparePush({ ...branch, destination: "main", mode: "force" });

  await source.writeFile("advanced.txt", "advanced\n");
  await source.commit("advance remote");
  await source.run(["push", "origin", "main"]);
  await service.push(client.id, force.token);
  expect((await server.run(["rev-parse", "main"])).trim()).toBe(force.localOid);
});

it.each(["ff", "ff-only", "rebase"] as const)(
  "preserves staged, unstaged and untracked work during a %s fast-forward pull",
  async (strategy) => {
    const { source, client, run, pull } = await setup();
    await writeFile(join(client.path, "file.txt"), "staged edit\n");
    await run(["add", "file.txt"]);
    await writeFile(join(client.path, "file.txt"), "unstaged edit\n");
    await writeFile(join(client.path, "local.txt"), "untracked work\n");
    const before = await run(["status", "--porcelain"]);
    const index = await run(["show", ":file.txt"]);
    await source.writeFile("remote.txt", "remote update\n");
    await source.commit("remote update");
    await source.run(["push", "origin", "main"]);

    const preview = await pull.prepare({ repositoryId: client.id, strategy });
    expect(await pull.execute(client.id, preview.token)).toBe("Pull completed.");
    expect((await run(["rev-parse", "HEAD"])).trim()).toBe(preview.source);
    expect(await run(["status", "--porcelain"])).toBe(before);
    expect(await run(["show", ":file.txt"])).toBe(index);
    expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("unstaged edit\n");
    expect(await readFile(join(client.path, "local.txt"), "utf8")).toBe("untracked work\n");
  },
);

it("keeps a recoverable autostash when restoring local edits conflicts after a fast-forward", async () => {
  const { source, client, run, pull } = await setup();
  await writeFile(join(client.path, "file.txt"), "keep my edit\n");
  await source.writeFile("file.txt", "remote edit\n");
  await source.commit("remote edit");
  await source.run(["push", "origin", "main"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff" });
  await expect(pull.execute(client.id, preview.token)).rejects.toThrow();
  expect((await run(["rev-parse", "HEAD"])).trim()).toBe(preview.source);
  expect(await run(["stash", "list"])).toContain("Eda pull autostash");
  expect(await run(["show", "stash@{0}:file.txt"])).toBe("keep my edit\n");
  expect(await readFile(join(client.path, "file.txt"), "utf8")).toContain("keep my edit");
});

it("rejects a changed branch between preparing and applying a fast-forward pull", async () => {
  const { source, client, run, pull } = await setup();
  await source.writeFile("remote.txt", "remote update\n");
  await source.commit("remote update");
  await source.run(["push", "origin", "main"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff" });
  await run(["checkout", "-b", "other"]);
  await expect(pull.execute(client.id, preview.token)).rejects.toThrow(/changed/);
  expect((await run(["rev-parse", "HEAD"])).trim()).toBe(preview.head);
});

async function divergentPullFixture() {
  const fixture = await setup();
  const { source, client, run } = fixture;
  await writeFile(join(client.path, "client.txt"), "local commit\n");
  await run(["add", "."]);
  await run(["commit", "-m", "local commit"]);
  await source.writeFile("remote.txt", "remote commit\n");
  await source.commit("remote commit");
  await source.run(["push", "origin", "main"]);
  await writeFile(join(client.path, "file.txt"), "staged edit\n");
  await run(["add", "file.txt"]);
  await writeFile(join(client.path, "file.txt"), "unstaged edit\n");
  await writeFile(join(client.path, "untracked.txt"), "untracked work\n");
  return fixture;
}

it("autostashes a divergent rebase and restores the exact staged and unstaged contents", async () => {
  const { client, run, pull } = await divergentPullFixture();
  const before = await run(["status", "--porcelain"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "rebase" });
  expect(await pull.execute(client.id, preview.token)).toBe("Pull completed.");
  expect(await run(["status", "--porcelain"])).toBe(before);
  expect(await run(["show", ":file.txt"])).toBe("staged edit\n");
  expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("unstaged edit\n");
  expect(await readFile(join(client.path, "untracked.txt"), "utf8")).toBe("untracked work\n");
  expect(await run(["stash", "list"])).toBe("");
});

it("retains a divergent merge's autostash across service restart and restores it after committing", async () => {
  const { source, client, run, pull, repositories, writer, identity, db } =
    await divergentPullFixture();
  const before = await run(["status", "--porcelain"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff" });

  expect(await pull.execute(client.id, preview.token)).toContain(
    "Review and complete the merge commit",
  );

  expect(await run(["stash", "list"])).toContain("Eda pull autostash");
  expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("initial\n");

  const workflows = new WorkflowService(
    source.git,
    repositories,
    writer,
    identity,
    new WorkflowJournal(db),
    new ContentRecoveryRepository(db),
  );

  const merge = await workflows.prepareMerge(client.id);
  await workflows.continueMerge(client.id, merge.id, "Merge upstream");
  expect(await run(["status", "--porcelain"])).toBe(before);
  expect(await run(["show", ":file.txt"])).toBe("staged edit\n");
  expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("unstaged edit\n");
  expect(await run(["stash", "list"])).toBe("");
});

it("restores local changes after aborting a divergent merge", async () => {
  const { client, run, pull, workflows } = await divergentPullFixture();
  const head = await run(["rev-parse", "HEAD"]);
  const before = await run(["status", "--porcelain"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff" });
  await pull.execute(client.id, preview.token);
  const abort = await workflows.prepareAbort(client.id);
  await workflows.abortMerge(client.id, abort.token);
  expect(await run(["rev-parse", "HEAD"])).toBe(head);
  expect(await run(["status", "--porcelain"])).toBe(before);
  expect(await run(["show", ":file.txt"])).toBe("staged edit\n");
  expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("unstaged edit\n");
  expect(await run(["stash", "list"])).toBe("");
});

it("does not stash or disturb local changes for a blocked fast-forward-only pull", async () => {
  const { client, run, pull } = await divergentPullFixture();
  const before = await run(["status", "--porcelain"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff-only" });
  expect(preview.blockedReason).toContain("diverged");
  expect(() => pull.execute(client.id, preview.token)).toThrow(/diverged/);
  expect(await run(["status", "--porcelain"])).toBe(before);
  expect(await run(["stash", "list"])).toBe("");
});

it("does not stash local changes when the upstream is already integrated", async () => {
  const { client, run, pull } = await setup();
  await writeFile(join(client.path, "file.txt"), "unsaved work\n");
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "rebase" });
  expect(await pull.execute(client.id, preview.token)).toBe("Already up to date.");
  expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("unsaved work\n");
  expect(await run(["stash", "list"])).toBe("");
});

it("preserves existing user stashes and restores local work when fast-forward execution fails", async () => {
  const { source, client, run, pull } = await setup();
  await writeFile(join(client.path, "old.txt"), "older saved work\n");
  await run(["stash", "push", "-u", "-m", "user stash"]);
  const existing = await run(["rev-parse", "refs/stash"]);
  await writeFile(join(client.path, "file.txt"), "local work\n");
  await source.writeFile("remote.txt", "remote update\n");
  await source.commit("remote update");
  await source.run(["push", "origin", "main"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff" });
  const original = source.git.exec.bind(source.git);

  const spy = vi.spyOn(source.git, "exec").mockImplementation((args, options) => {
    if (args.includes("merge") && args.includes("--ff-only"))
      return Promise.reject(new Error("injected merge failure"));
    return original(args, options);
  });

  try {
    await expect(pull.execute(client.id, preview.token)).rejects.toThrow("injected merge failure");
  } finally {
    spy.mockRestore();
  }

  expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("local work\n");
  expect(await run(["rev-parse", "refs/stash"])).toBe(existing);
  expect(await run(["stash", "list"])).toContain("user stash");
  expect(await run(["stash", "list"])).not.toContain("Eda pull autostash");
});

async function conflictingRebaseFixture() {
  const fixture = await setup();
  const { source, client, run } = fixture;
  await writeFile(join(client.path, "file.txt"), "local commit\n");
  await run(["add", "."]);
  await run(["commit", "-m", "local commit"]);
  await source.writeFile("file.txt", "remote commit\n");
  await source.commit("remote commit");
  await source.run(["push", "origin", "main"]);
  await writeFile(join(client.path, "notes.txt"), "staged note\n");
  await run(["add", "notes.txt"]);
  await writeFile(join(client.path, "notes.txt"), "unstaged note\n");
  await writeFile(join(client.path, "untracked.txt"), "untracked work\n");
  return fixture;
}

it.each(["continue", "abort"] as const)(
  "restores the saved index and files after a conflicted rebase is restarted and %sd",
  async (action) => {
    const fixture = await conflictingRebaseFixture();
    const { source, client, run, pull, repositories, writer, identity, db } = fixture;
    const head = await run(["rev-parse", "HEAD"]);
    const before = await run(["status", "--porcelain"]);
    const preview = await pull.prepare({ repositoryId: client.id, strategy: "rebase" });
    expect(await pull.execute(client.id, preview.token)).toContain("Pull paused");
    expect(await run(["stash", "list"])).toContain("Eda pull autostash");

    const journal = new WorkflowJournal(db);
    const recovery = new ContentRecoveryRepository(db);

    const workflows = new WorkflowService(
      source.git,
      repositories,
      writer,
      identity,
      journal,
      recovery,
    );

    const rebase = new RebaseService(
      source.git,
      repositories,
      writer,
      identity,
      workflows,
      journal,
      recovery,
    );

    if (action === "continue") {
      await writeFile(join(client.path, "file.txt"), "resolved commit\n");
      await run(["add", "file.txt"]);
    }

    const review = await rebase.prepare(client.id, action);
    expect((await rebase.execute(client.id, review.token)).state).toBe("completed");
    if (action === "abort") expect(await run(["rev-parse", "HEAD"])).toBe(head);
    expect(await run(["status", "--porcelain"])).toBe(before);
    expect(await run(["show", ":notes.txt"])).toBe("staged note\n");
    expect(await readFile(join(client.path, "notes.txt"), "utf8")).toBe("unstaged note\n");
    expect(await readFile(join(client.path, "untracked.txt"), "utf8")).toBe("untracked work\n");
    expect(await run(["stash", "list"])).toBe("");
  },
);

it.each(["ff", "rebase"] as const)(
  "restores the autostash when a divergent %s command fails before starting",
  async (strategy) => {
    const { source, client, run, pull } = await divergentPullFixture();
    const before = await run(["status", "--porcelain"]);
    const preview = await pull.prepare({ repositoryId: client.id, strategy });
    const original = source.git.exec.bind(source.git);

    const spy = vi.spyOn(source.git, "exec").mockImplementation((args, options) => {
      if (
        (strategy === "ff" && args.includes("merge") && args.includes("--no-commit")) ||
        (strategy === "rebase" && args.includes("rebase") && args.includes("--merge"))
      )
        return Promise.reject(new Error("injected integration failure"));

      return original(args, options);
    });

    try {
      await expect(pull.execute(client.id, preview.token)).rejects.toThrow(
        "injected integration failure",
      );
    } finally {
      spy.mockRestore();
    }

    expect(await run(["status", "--porcelain"])).toBe(before);
    expect(await run(["show", ":file.txt"])).toBe("staged edit\n");
    expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("unstaged edit\n");
    expect(await run(["stash", "list"])).toBe("");
  },
);

it("retains an untracked autostashed file if upstream introduces the same path", async () => {
  const { source, client, run, pull } = await setup();
  await writeFile(join(client.path, "introduced.txt"), "local untracked work\n");
  await source.writeFile("introduced.txt", "remote tracked work\n");
  await source.commit("introduce file");
  await source.run(["push", "origin", "main"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff" });
  await expect(pull.execute(client.id, preview.token)).rejects.toThrow(/remain saved in Stashes/);
  expect((await run(["rev-parse", "HEAD"])).trim()).toBe(preview.source);
  expect(await readFile(join(client.path, "introduced.txt"), "utf8")).toBe("remote tracked work\n");
  expect(await run(["show", "stash@{0}^3:introduced.txt"])).toBe("local untracked work\n");
});

it("keeps the named stash recoverable when cancellation prevents restoration", async () => {
  const { source, client, run, pull } = await setup();
  await writeFile(join(client.path, "file.txt"), "staged work\n");
  await run(["add", "file.txt"]);
  await writeFile(join(client.path, "file.txt"), "unstaged work\n");
  await writeFile(join(client.path, "untracked.txt"), "untracked work\n");
  await source.writeFile("remote.txt", "remote update\n");
  await source.commit("remote update");
  await source.run(["push", "origin", "main"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff" });
  const original = source.git.exec.bind(source.git);
  let cancelled = false;

  const spy = vi.spyOn(source.git, "exec").mockImplementation((args, options) => {
    if (args.includes("merge") && args.includes("--ff-only")) cancelled = true;

    if (cancelled)
      return Promise.reject(
        new GitError(errorFixture({ kind: "cancelled", operation: "pull", message: "Cancelled" })),
      );

    return original(args, options);
  });

  try {
    await expect(pull.execute(client.id, preview.token)).rejects.toThrow(/remain saved in Stashes/);
  } finally {
    spy.mockRestore();
  }

  expect(await run(["stash", "list"])).toContain("Eda pull autostash");
  expect(await run(["show", "stash@{0}^2:file.txt"])).toBe("staged work\n");
  expect(await run(["show", "stash@{0}:file.txt"])).toBe("unstaged work\n");
  expect(await run(["show", "stash@{0}^3:untracked.txt"])).toBe("untracked work\n");
  expect((await run(["rev-parse", "HEAD"])).trim()).toBe(preview.head);
});

it("restores renamed, deleted and binary files without disturbing an existing user stash", async () => {
  const { source, client, run, pull } = await setup();
  await writeFile(join(client.path, "old-notes.txt"), "existing user stash\n");
  await run(["stash", "push", "-u", "-m", "user stash"]);
  const existing = await run(["rev-parse", "refs/stash"]);
  await run(["mv", "file.txt", "renamed.txt"]);
  await writeFile(join(client.path, "renamed.txt"), "unstaged rename edit\n");
  const bytes = Buffer.from([0, 255, 2, 3, 0, 127]);
  await writeFile(join(client.path, "binary.bin"), bytes);
  await run(["add", "binary.bin"]);
  const before = await run(["status", "--porcelain"]);
  const index = await run(["ls-files", "--stage"]);
  await source.writeFile("remote.txt", "remote update\n");
  await source.commit("remote update");
  await source.run(["push", "origin", "main"]);
  const preview = await pull.prepare({ repositoryId: client.id, strategy: "ff" });
  await pull.execute(client.id, preview.token);
  expect(await run(["status", "--porcelain"])).toBe(before);

  expect(
    (await run(["ls-files", "--stage"]))
      .split("\n")
      .filter((line) => line && !line.endsWith("\tremote.txt"))
      .join("\n"),
  ).toBe(index.trimEnd());

  expect(await readFile(join(client.path, "renamed.txt"), "utf8")).toBe("unstaged rename edit\n");
  expect(await readFile(join(client.path, "binary.bin"))).toEqual(bytes);
  expect(await run(["rev-parse", "refs/stash"])).toBe(existing);
});

it("leaves local work and existing stashes untouched when fetching fails", async () => {
  const { service, client, run, pull } = await setup();
  await writeFile(join(client.path, "saved.txt"), "existing saved work\n");
  await run(["stash", "push", "-u", "-m", "user stash"]);
  const existing = await run(["rev-parse", "refs/stash"]);
  await writeFile(join(client.path, "file.txt"), "staged work\n");
  await run(["add", "file.txt"]);
  await writeFile(join(client.path, "file.txt"), "unstaged work\n");
  const before = await run(["status", "--porcelain"]);

  const spy = vi
    .spyOn(service, "fetchInPlace")
    .mockRejectedValue(
      new GitError(
        errorFixture({ kind: "auth-failed", operation: "fetch", message: "Authentication failed" }),
      ),
    );

  try {
    await expect(pull.prepare({ repositoryId: client.id, strategy: "rebase" })).rejects.toThrow(
      "Authentication failed",
    );
  } finally {
    spy.mockRestore();
  }

  expect(await run(["status", "--porcelain"])).toBe(before);
  expect(await run(["rev-parse", "refs/stash"])).toBe(existing);
  expect(await run(["show", ":file.txt"])).toBe("staged work\n");
  expect(await readFile(join(client.path, "file.txt"), "utf8")).toBe("unstaged work\n");
});

it.each([
  ["preview", "https://github.com/example/repo.git", false, false, "github-auth-required"],
  ["push", "https://github.com/example/repo.git", false, false, "github-auth-required"],
  ["preview", "https://github.com/example/repo.git", false, true, "github-access-required"],
  ["push", "https://github.com/example/repo.git", false, true, "github-access-required"],
  ["push", "https://github.com/example/repo.git", true, false, "auth-failed"],
  ["push", "https://example.com/repo.git", false, false, "auth-failed"],
] as const)(
  "routes %s authentication failures for %s (manual: %s, denied: %s) to %s",
  async (phase, url, manual, denied, kind) => {
    const ctx = await setup({ forFetch: vi.fn(async () => undefined) });
    await ctx.run(["remote", "set-url", "--push", "origin", url]);
    const execute = ctx.source.git.exec.bind(ctx.source.git);
    const credentials = manual ? { username: "user", password: "manual-token" } : undefined;

    const spy = vi.spyOn(ctx.source.git, "exec").mockImplementation(async (args, options) => {
      const preview = args[0] === "ls-remote";
      const push = args.includes("push");

      if ((phase === "preview" && preview) || (phase === "push" && push))
        throw new GitError({
          kind: "auth-failed",
          operation: "push",
          message: "Authentication failed",
          rawStderr: denied
            ? "fatal: unable to access repository: The requested URL returned error: 403"
            : "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        });

      if (preview) {
        const local = [...args];
        local[local.indexOf("--") + 1] = ctx.server.path;
        expect(options.env?.overrides?.["GIT_ALLOW_PROTOCOL"]).toBe("https");
        return execute(local, { ...options, env: { overrides: { GIT_ALLOW_PROTOCOL: "file" } } });
      }

      return execute(args, options);
    });

    try {
      const preparing = ctx.service.preparePush({
        repositoryId: ctx.client.id,
        remote: "origin",
        branch: "main",
        destination: "main",
        mode: "normal",
        setUpstream: false,
        ...(credentials ? { credentials } : {}),
      });

      if (phase === "preview") {
        await expect(preparing).rejects.toMatchObject({ kind });
      } else {
        const preview = await preparing;

        await expect(
          ctx.service.push(ctx.client.id, preview.token, credentials),
        ).rejects.toMatchObject({
          kind,
        });
      }
    } finally {
      spy.mockRestore();
    }
  },
);

it.each([false, true])(
  "authenticates push preview and execution with saved OAuth or an explicit override (manual: %s)",
  async (manual) => {
    const saved = { username: "x-access-token", password: "saved-push-token" };
    const refreshed = { username: "x-access-token", password: "refreshed-push-token" };
    const override = { username: "manual-user", password: "manual-push-token" };
    const github = { forFetch: vi.fn(async () => saved) };
    const ctx = await setup(github);
    const url = "https://github.com/example/push-only.git";
    await ctx.run(["remote", "set-url", "--push", "origin", url]);
    const execute = ctx.source.git.exec.bind(ctx.source.git);
    const transports: string[] = [];
    let expected = manual ? override : saved;

    const spy = vi.spyOn(ctx.source.git, "exec").mockImplementation(async (args, options) => {
      const push = args.includes("push");
      if (args[0] !== "ls-remote" && !push) return execute(args, options);
      transports.push(push ? "push" : "preview");
      expect(options.identityName).toBe(ctx.profile.name);

      expect(Object.values(options.env?.overrides ?? {})).toContain(
        `Authorization: Basic ${Buffer.from(`${expected.username}:${expected.password}`).toString("base64")}`,
      );

      expect(options.redactValues).toContain(expected.password);
      const local = [...args];
      local[local.indexOf("--") + 1] = ctx.server.path;
      expect(options.env?.overrides?.["GIT_ALLOW_PROTOCOL"]).toBe("https");
      return execute(local, { ...options, env: { overrides: { GIT_ALLOW_PROTOCOL: "file" } } });
    });

    try {
      const preview = await ctx.service.preparePush({
        repositoryId: ctx.client.id,
        remote: "origin",
        branch: "main",
        destination: "authenticated-push",
        mode: "normal",
        setUpstream: false,
        ...(manual ? { credentials: override } : {}),
      });

      expect(preview.url).toBe(url);
      expected = manual ? override : refreshed;
      github.forFetch.mockResolvedValue(refreshed);
      await ctx.service.push(ctx.client.id, preview.token, manual ? override : undefined);
      expect(transports).toEqual(["preview", "push"]);

      expect(
        (
          await ctx.source.run(["rev-parse", "refs/heads/authenticated-push"], ctx.server.path)
        ).trim(),
      ).toBe(preview.localOid);

      if (manual) expect(github.forFetch).not.toHaveBeenCalled();
      else {
        expect(github.forFetch).toHaveBeenCalledTimes(2);
        expect(github.forFetch).toHaveBeenNthCalledWith(1, ctx.profile.id, url);
        expect(github.forFetch).toHaveBeenNthCalledWith(2, ctx.profile.id, url);
      }

      const activity = JSON.stringify(ctx.operations.list(ctx.profile.id));
      for (const credential of [saved, refreshed, override])
        expect(activity).not.toContain(credential.password);
    } finally {
      spy.mockRestore();
    }
  },
);

it("uses the captured profile’s saved GitHub OAuth for HTTPS fetch/pull, preserves local work and keeps credentials out of Activity", async () => {
  const credentials = { username: "github-user", password: "gho_saved_oauth_fixture" };

  const github = {
    forFetch: vi.fn(async (_profile: string, url: string) =>
      isGitHubHttps(url) ? credentials : undefined,
    ),
  };

  const ctx = await setup(github);
  const url = "https://github.com/example/private-repository.git";
  await ctx.run(["remote", "set-url", "origin", url]);
  await ctx.source.writeFile("remote-update.txt", "fetched with saved OAuth\n");
  await ctx.source.commit("remote update");
  await ctx.source.run(["push", "origin", "main"]);
  await writeFile(join(ctx.client.path, "local-draft.txt"), "keep local bytes\n");
  const execute = ctx.source.git.exec.bind(ctx.source.git);
  let rejected = false;
  let accessDenied = false;
  let expected = credentials;

  const spy = vi.spyOn(ctx.source.git, "exec").mockImplementation(async (args, options) => {
    const index = args.indexOf(url);
    if (args[0] !== "fetch" || index < 0) return execute(args, options);
    expect(options.identityName).toBe(ctx.profile.name);

    expect(Object.values(options.env?.overrides ?? {})).toContain(
      `Authorization: Basic ${Buffer.from(`${expected.username}:${expected.password}`).toString("base64")}`,
    );

    expect(options.redactValues).toContain(expected.password);

    if (rejected)
      throw new GitError(
        errorFixture({
          kind: "auth-failed",
          operation: "fetch",
          message: "Authentication failed",
          ...(accessDenied ? { rawStderr: "The requested URL returned error: 403" } : {}),
        }),
      );

    const local = [...args];
    local[index] = ctx.server.path;
    expect(options.env?.overrides?.["GIT_ALLOW_PROTOCOL"]).toBe("https");
    return execute(local, { ...options, env: { overrides: { GIT_ALLOW_PROTOCOL: "file" } } });
  });

  try {
    const review = await ctx.pull.prepare({ repositoryId: ctx.client.id, strategy: "ff-only" });
    expect(review.behind).toBe(1);
    await ctx.pull.execute(ctx.client.id, review.token);

    expect(await readFile(join(ctx.client.path, "remote-update.txt"), "utf8")).toBe(
      "fetched with saved OAuth\n",
    );

    expect(await readFile(join(ctx.client.path, "local-draft.txt"), "utf8")).toBe(
      "keep local bytes\n",
    );

    expect(github.forFetch).toHaveBeenCalledWith(ctx.profile.id, url);
    expect(JSON.stringify(ctx.operations.list(ctx.profile.id))).not.toContain(credentials.password);
    github.forFetch.mockClear();
    expected = { username: "manual-user", password: "manual-override" };

    await ctx.service.fetch({
      repositoryId: ctx.client.id,
      remote: "origin",
      prune: false,
      tags: false,
      credentials: expected,
    });

    expect(github.forFetch).not.toHaveBeenCalled();
    rejected = true;

    await expect(
      ctx.service.fetch({
        repositoryId: ctx.client.id,
        remote: "origin",
        prune: false,
        tags: false,
        credentials: expected,
      }),
    ).rejects.toMatchObject({ kind: "auth-failed" });

    expect(github.forFetch).not.toHaveBeenCalled();
    expected = credentials;
    rejected = true;

    await expect(
      ctx.service.fetch({
        repositoryId: ctx.client.id,
        remote: "origin",
        prune: false,
        tags: false,
      }),
    ).rejects.toMatchObject({ kind: "github-auth-required" });

    accessDenied = true;

    await expect(
      ctx.service.fetch({
        repositoryId: ctx.client.id,
        remote: "origin",
        prune: false,
        tags: false,
      }),
    ).rejects.toMatchObject({ kind: "github-access-required" });
  } finally {
    spy.mockRestore();
  }
});

it("lists remote tags without fetching them, keeping annotated tag object IDs and using the push destination", async () => {
  const { service, source, server, client, run, operations, profile } = await setup();
  await source.run(["tag", "-a", "annotated", "-m", "release notes"]);
  await source.run(["tag", "lightweight"]);
  await source.run(["push", "origin", "--tags"]);
  await run(["tag", "private"]);
  const before = await run(["show-ref"]);
  const operationCount = operations.list(profile.id).length;
  const tags = await service.listTags({ repositoryId: client.id, remote: "origin" });

  expect(tags).toEqual([
    { name: "annotated", oid: (await server.run(["rev-parse", "refs/tags/annotated"])).trim() },
    { name: "lightweight", oid: (await server.run(["rev-parse", "refs/tags/lightweight"])).trim() },
  ]);

  expect(await run(["show-ref"])).toBe(before);
  expect(operations.list(profile.id)).toHaveLength(operationCount);
  expect(await run(["tag", "--list"])).toBe("private\n");
  await service.change(client.id, { kind: "url", name: "origin", url: client.path, push: false });
  await service.change(client.id, { kind: "url", name: "origin", url: server.path, push: true });
  expect(await service.listTags({ repositoryId: client.id, remote: "origin" })).toEqual(tags);

  await expect(
    service.listTags({ repositoryId: client.id, remote: "--all" }),
  ).rejects.toMatchObject({ kind: "invalid-input" });
});

it.each([false, true])(
  "authenticates GitLab push preview and execution with saved OAuth or an explicit override (manual: %s)",
  async (manual) => {
    const saved = { username: "oauth2", password: "saved-push-token" };
    const refreshed = { username: "oauth2", password: "refreshed-push-token" };
    const override = { username: "manual-user", password: "manual-push-token" };
    const gitlab = { forFetch: vi.fn(async () => saved) };
    const ctx = await setup(undefined, gitlab);
    const url = "https://gitlab.com/example/push-only.git";
    await ctx.run(["remote", "set-url", "--push", "origin", url]);
    const execute = ctx.source.git.exec.bind(ctx.source.git);
    const transports: string[] = [];
    let expected = manual ? override : saved;

    const spy = vi.spyOn(ctx.source.git, "exec").mockImplementation(async (args, options) => {
      const push = args.includes("push");
      if (args[0] !== "ls-remote" && !push) return execute(args, options);
      transports.push(push ? "push" : "preview");
      expect(options.identityName).toBe(ctx.profile.name);

      expect(Object.values(options.env?.overrides ?? {})).toContain(
        `Authorization: Basic ${Buffer.from(`${expected.username}:${expected.password}`).toString("base64")}`,
      );

      expect(options.redactValues).toContain(expected.password);
      const local = [...args];
      local[local.indexOf("--") + 1] = ctx.server.path;
      expect(options.env?.overrides?.["GIT_ALLOW_PROTOCOL"]).toBe("https");
      return execute(local, { ...options, env: { overrides: { GIT_ALLOW_PROTOCOL: "file" } } });
    });

    try {
      const preview = await ctx.service.preparePush({
        repositoryId: ctx.client.id,
        remote: "origin",
        branch: "main",
        destination: "authenticated-push",
        mode: "normal",
        setUpstream: false,
        ...(manual ? { credentials: override } : {}),
      });

      expect(preview.url).toBe(url);
      expected = manual ? override : refreshed;
      gitlab.forFetch.mockResolvedValue(refreshed);
      await ctx.service.push(ctx.client.id, preview.token, manual ? override : undefined);
      expect(transports).toEqual(["preview", "push"]);

      expect(
        (
          await ctx.source.run(["rev-parse", "refs/heads/authenticated-push"], ctx.server.path)
        ).trim(),
      ).toBe(preview.localOid);

      if (manual) expect(gitlab.forFetch).not.toHaveBeenCalled();
      else {
        expect(gitlab.forFetch).toHaveBeenCalledTimes(2);
        expect(gitlab.forFetch).toHaveBeenNthCalledWith(1, ctx.profile.id, url);
        expect(gitlab.forFetch).toHaveBeenNthCalledWith(2, ctx.profile.id, url);
      }

      const activity = JSON.stringify(ctx.operations.list(ctx.profile.id));
      for (const credential of [saved, refreshed, override])
        expect(activity).not.toContain(credential.password);
    } finally {
      spy.mockRestore();
    }
  },
);

it("uses saved GitLab credentials for nested-group fetch and respects explicit manual credentials", async () => {
  const credentials = { username: "oauth2", password: "gitlab-secret" };

  const gitlab = {
    forFetch: vi.fn(async (_profile: string, url: string) =>
      isGitLabHttps(url) ? credentials : undefined,
    ),
  };

  const ctx = await setup(undefined, gitlab);
  const url = "https://gitlab.com/team/subgroup/private.git";
  await ctx.run(["remote", "set-url", "origin", url]);
  const execute = ctx.source.git.exec.bind(ctx.source.git);
  let expected = credentials;

  const spy = vi.spyOn(ctx.source.git, "exec").mockImplementation(async (args, options) => {
    if (args[0] !== "fetch") return execute(args, options);

    expect(Object.values(options.env?.overrides ?? {})).toContain(
      `Authorization: Basic ${Buffer.from(`${expected.username}:${expected.password}`).toString("base64")}`,
    );

    expect(options.redactValues).toContain(expected.password);
    const local = [...args];
    local[local.indexOf("--") + 1] = ctx.server.path;
    return execute(local, { ...options, env: { overrides: { GIT_ALLOW_PROTOCOL: "file" } } });
  });

  try {
    const request = { repositoryId: ctx.client.id, remote: "origin", prune: false, tags: false };
    await ctx.service.fetch(request);
    expect(gitlab.forFetch).toHaveBeenCalledWith(ctx.profile.id, url);
    expect(JSON.stringify(ctx.operations.list(ctx.profile.id))).not.toContain(credentials.password);
    gitlab.forFetch.mockClear();
    expected = { username: "manual", password: "manual-secret" };
    await ctx.service.fetch({ ...request, credentials: expected });
    expect(gitlab.forFetch).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it.each([false, true])(
  "uses saved GitLab OAuth for cloning unless manual credentials are supplied (%s)",
  async (manual) => {
    const saved = { username: "oauth2", password: "gitlab-clone-secret" };
    const override = { username: "manual", password: "manual-clone-secret" };

    const gitlab = {
      forFetch: vi.fn(async (_profile: string, url: string) =>
        isGitLabHttps(url) ? saved : undefined,
      ),
    };

    const ctx = await setup(undefined, gitlab);
    const url = "https://gitlab.com/team/subgroup/private.git";
    const expected = manual ? override : saved;
    const execute = ctx.source.git.exec.bind(ctx.source.git);
    gitlab.forFetch.mockClear();

    const spy = vi.spyOn(ctx.source.git, "exec").mockImplementation(async (args, options) => {
      if (args[0] !== "clone") return execute(args, options);

      expect(Object.values(options.env?.overrides ?? {})).toContain(
        `Authorization: Basic ${Buffer.from(`${expected.username}:${expected.password}`).toString("base64")}`,
      );

      expect(options.redactValues).toContain(expected.password);
      const local = [...args];
      local[local.indexOf("--") + 1] = ctx.server.path;
      return execute(local, { ...options, env: { overrides: { GIT_ALLOW_PROTOCOL: "file" } } });
    });

    try {
      const result = await ctx.service.clone({
        profileId: ctx.profile.id,
        url,
        parent: ctx.source.home,
        name: "gitlab clone",
        ...(manual ? { credentials: override } : {}),
      });

      expect(await readFile(join(result.path, "file.txt"), "utf8")).toBe("initial\n");
      if (manual) expect(gitlab.forFetch).not.toHaveBeenCalled();
      else expect(gitlab.forFetch).toHaveBeenCalledExactlyOnceWith(ctx.profile.id, url);
      expect(JSON.stringify(ctx.operations.list(ctx.profile.id))).not.toContain(expected.password);
    } finally {
      spy.mockRestore();
    }
  },
);

it("uses a self-hosted PAT for clone, fetch, remote tags, push preview and execution, with manual overrides", async () => {
  const saved = { username: "oauth2", password: "self-hosted-private-token" };
  const override = { username: "manual", password: "manual-private-token" };
  const gitlab = { forFetch: vi.fn(async () => undefined) };

  const selfHosted = {
    forFetch: vi.fn(async () => saved),
    ignoresTlsErrors: vi.fn(() => true),
  };

  const ctx = await setup(undefined, gitlab, selfHosted);
  const url = "https://git.company.test/gitlab/team/subgroup/private.git";
  await ctx.run(["remote", "set-url", "origin", url]);
  const execute = ctx.source.git.exec.bind(ctx.source.git);
  const transports: string[] = [];
  let expected = saved;

  const spy = vi.spyOn(ctx.source.git, "exec").mockImplementation(async (args, options) => {
    const operation = ["clone", "fetch", "ls-remote", "push"].find((name) => args.includes(name));
    if (!operation) return execute(args, options);
    transports.push(operation);
    const overrides = options.env?.overrides ?? {};
    const config = Object.entries(overrides).filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"));

    const header = config.find(
      ([key, value]) =>
        value === `http.${url}/.extraHeader` &&
        overrides[key.replace("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")] ===
          `Authorization: Basic ${Buffer.from(`${expected.username}:${expected.password}`).toString("base64")}`,
    );

    expect(header).toBeDefined();

    expect(Object.values(overrides)).toContain(
      `Authorization: Basic ${Buffer.from(`${expected.username}:${expected.password}`).toString("base64")}`,
    );

    expect(Object.values(overrides)).toContain("http.followRedirects");
    const tls = config.find(([, value]) => value === `http.${url}/.sslVerify`);
    expect(tls).toBeDefined();
    expect(overrides[tls![0].replace("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")]).toBe("false");
    expect(overrides["GIT_SSL_NO_VERIFY"]).toBeUndefined();
    expect(options.redactValues).toContain(expected.password);
    const local = [...args];
    local[local.indexOf("--") + 1] = ctx.server.path;
    return execute(local, { ...options, env: { overrides: { GIT_ALLOW_PROTOCOL: "file" } } });
  });

  try {
    const cloned = await ctx.service.clone({
      profileId: ctx.profile.id,
      url,
      parent: ctx.source.home,
      name: "self hosted clone",
    });

    expect(await readFile(join(cloned.path, "file.txt"), "utf8")).toBe("initial\n");
    const request = { repositoryId: ctx.client.id, remote: "origin", prune: false, tags: false };
    await ctx.service.fetch(request);
    await ctx.service.listTags({ repositoryId: ctx.client.id, remote: "origin" });

    const preview = await ctx.service.preparePush({
      repositoryId: ctx.client.id,
      remote: "origin",
      branch: "main",
      destination: "self-hosted-push",
      mode: "normal",
      setUpstream: false,
    });

    await ctx.service.push(ctx.client.id, preview.token);
    expect(transports).toEqual(["clone", "fetch", "ls-remote", "ls-remote", "push"]);
    expect(selfHosted.forFetch).toHaveBeenCalledWith(ctx.profile.id, url);
    selfHosted.forFetch.mockClear();
    gitlab.forFetch.mockClear();
    expected = override;
    await ctx.service.fetch({ ...request, credentials: override });
    expect(selfHosted.forFetch).not.toHaveBeenCalled();
    expect(gitlab.forFetch).not.toHaveBeenCalled();
    const activity = JSON.stringify(ctx.operations.list(ctx.profile.id));
    expect(activity).not.toContain(saved.password);
    expect(activity).not.toContain(override.password);
  } finally {
    spy.mockRestore();
  }
});
