import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import type { EdaApi } from "@shared/ipc";
import {
  builtInSetting,
  type ResolvedSetting,
  type SettingKey,
  type SettingScope,
  type SettingValues,
} from "@shared/preferences/settings";
import type { RepositorySummary } from "@shared/repository/repository";
import {
  UNSIGNED_COMMIT_SIGNATURE,
  type RepositoryStatus,
  type UnifiedDiff,
} from "@shared/repository/repository-read";
import type { StashEntry } from "@shared/workflows/stashes";
import { commits, containingDemoRefs, demoBranches, demoTags } from "./demo-history";
export { commits } from "./demo-history";

export const demoIdentity: Identity = {
  id: "tour-profile",
  name: t("tutorial.demo.profileName"),
  gitName: t("tutorial.demo.edaExplorer"),
  gitEmail: "explorer@example.test",
  hue: 190,
  signing: { format: "none", signCommits: false },
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
export const demoRepositories: RepositorySummary[] = [
  t("tutorial.demo.helloEda"),
  t("tutorial.demo.weekendWebsite"),
  t("tutorial.demo.notes"),
].map((name, index) => ({
  id: `tour-repo-${index}`,
  identityId: demoIdentity.id,
  name,
  path: `/demo/${name.toLowerCase().replaceAll(" ", "-")}`,
  favourite: index === 0,
  available: true,
}));
export const demoDiff: UnifiedDiff = {
  files: [
    {
      oldPath: "README.md",
      newPath: "README.md",
      status: "modified",
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          heading: "",
          lines: [
            {
              type: "context",
              content: t("tutorial.demo.readmeHeading"),
              oldLineNumber: 1,
              newLineNumber: 1,
            },
            { type: "deletion", content: t("tutorial.demo.originalGreeting"), oldLineNumber: 2 },
            {
              type: "addition",
              content: t("tutorial.demo.updatedGreeting"),
              newLineNumber: 2,
            },
          ],
        },
      ],
    },
  ],
};
const initialStatus = (): RepositoryStatus => ({
  branch: {
    head: "main",
    oid: commits[0]!.oid,
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    detached: false,
    unborn: false,
  },
  changes: ["README.md", "src/greeting.ts"].map((path) => ({
    kind: "ordinary",
    path,
    index: ".",
    worktree: "M",
    submodule: "N...",
  })),
});
const ok = <T>(value: T) => ({ ok: true as const, value });

export function createDemo() {
  let platform: EdaApi["app"]["platform"] = "linux";
  const avatar = { dataUrl: null, expiresAt: Number.MAX_SAFE_INTEGER };
  let preferences: Partial<{ [K in SettingKey]: ResolvedSetting<K> }> = {};
  let diffMode: ResolvedSetting<"diffMode"> | undefined;
  let status = initialStatus();
  let entries: StashEntry[] = [];
  let savedChanges = status.changes;
  const repository: Partial<EdaApi["repository"]> = {
    list: async () => ok(demoRepositories),
    status: async () => ok(structuredClone(status)),
    history: async () => ok({ commits, nextOffset: null }),
    commitSignature: async () => ok(UNSIGNED_COMMIT_SIGNATURE),
    workingDiff: async () => ok(demoDiff),
    commitDiff: async () => ok(demoDiff),
    commitMessage: async (_id, oid) => {
      const { subject, body } = commits.find((commit) => commit.oid === oid) ?? commits[0]!;
      return ok(body ? `${subject}\n\n${body}` : subject);
    },
    inspectCommit: async (_id, oid) =>
      ok({
        commit: commits.find((c) => c.oid === oid) ?? commits[0]!,
        containingRefs: containingDemoRefs(oid),
        shallow: false,
        signed: false,
        signature: { status: "unsigned", format: null, reasonCode: null, diagnostics: "" },
      }),
    listBranches: async () => ok(demoBranches),
    listTags: async () => ok(demoTags),
    previewCommit: async () =>
      ok({
        author: { name: demoIdentity.gitName, email: demoIdentity.gitEmail },
        matchesProfile: true,
        signingEnabled: false,
        signing: t("tutorial.demo.unsigned"),
        additions: 1,
        deletions: 1,
        binaryFiles: 0,
        sharedRefs: [],
      }),
    stage: async ({ paths }) => {
      status.changes = status.changes.map((c) =>
        !paths || paths.includes(c.path) ? { ...c, index: "M", worktree: "." } : c,
      );
      return ok(undefined);
    },
    unstage: async ({ paths }) => {
      status.changes = status.changes.map((c) =>
        !paths || paths.includes(c.path) ? { ...c, index: ".", worktree: "M" } : c,
      );
      return ok(undefined);
    },
  };
  const stashes: Partial<EdaApi["stashes"]> = {
    list: async () => ok({ entries: [...entries], truncated: false }),
    create: async (_id, message, _contents, options) => {
      savedChanges = status.changes.filter(
        (c) =>
          (!options?.paths || options.paths.includes(c.path)) &&
          (!options?.stagedOnly || c.index !== "."),
      );
      status.changes = status.changes.filter(
        (c) => !savedChanges.includes(c) || (options?.keepIndex && c.index !== "."),
      );
      entries = [{ oid: "a".repeat(40), selector: "stash@{0}", message, timestamp: 1767268800 }];
      return ok(undefined);
    },
    inspect: async () =>
      ok({
        entry: entries[0]!,
        token: "demo-stash",
        tracked: demoDiff,
        staged: { files: [] },
        untracked: null,
      }),
    apply: async (_id, _token, pop) => {
      status.changes = [
        ...status.changes.filter((c) => !savedChanges.some((s) => s.path === c.path)),
        ...savedChanges,
      ];
      if (pop) entries = [];
      return ok({ applied: true, kept: !pop });
    },
  };
  const implementations = {
    repository,
    stashes,
    operations: { list: async () => ok([]) },
    backgroundFetch: {
      inspect: async () =>
        ok({ intervalMinutes: 0, online: true, suspended: true, fetching: false, remotes: [] }),
    },
    app: {
      installation: async () => ok({ method: "development" as const }),
      get platform() {
        return platform;
      },
      windowControl: async () => ok({ maximized: false }),
    },
    settings: {
      resolve: async <K extends SettingKey>(key: K) => {
        const saved = key === "diffMode" && diffMode ? diffMode : preferences[key];
        return ok(structuredClone((saved ?? builtInSetting(key)) as ResolvedSetting<K>));
      },
      set: async <K extends SettingKey>(key: K, scope: SettingScope, value: SettingValues[K]) => {
        if (key !== "diffMode" || (value !== "unified" && value !== "split"))
          return {
            ok: false as const,
            error: new GitError({
              kind: "cancelled",
              operation: "tour.settings.set",
              message: errorText("tutorial.demo.thisSettingCannotBeChangedInTheGuidedDemo"),
            }).toData(),
          };
        diffMode = { key: "diffMode", value, source: scope, hasOverride: true };
        return ok(undefined);
      },
    },
    sessions: { change: async () => ok(undefined) },
    avatars: { get: async () => ok(avatar) },
    identity: {
      inspectGit: async () =>
        ok({ profileId: demoIdentity.id, global: [], repository: null, localOverrides: [] }),
    },
  };
  const api = new Proxy(implementations, {
    get(target, group: string) {
      const members = Reflect.get(target, group) ?? {};
      return new Proxy(members, {
        get(values, method: string) {
          if (Reflect.has(values, method)) return Reflect.get(values, method);
          if (group === "events") return () => () => {};
          return async () => ({
            ok: false,
            error: new GitError({
              kind: "cancelled",
              operation: `tour.${group}.${method}`,
              message: errorText(
                "tutorial.demo.thisActionIsOutsideTheGuidedDemoYourRealWorkspaceIsUnchanged",
              ),
            }).toData(),
          });
        },
      });
    },
  }) as unknown as EdaApi;
  return {
    api,
    setPresentation(next: {
      platform: EdaApi["app"]["platform"];
      preferences?: typeof preferences;
    }) {
      platform = next.platform;
      if (next.preferences) preferences = structuredClone(next.preferences);
      return diffMode;
    },
    reset() {
      status = initialStatus();
      entries = [];
    },
    hasStash: () => entries.length > 0,
  };
}
