import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { commitGitConfig, type Identity } from "@shared/identity/identity";
import {
  isFlowConfig,
  isFlowPlan,
  type FlowAction,
  type FlowConfig,
  type FlowPlan,
  type FlowState,
} from "@shared/workflows/gitflow";
import { assertValidRefName } from "../validation";
import type { GitService } from "../git-service";
import { withLocalConfiguration } from "../configuration/local-configuration";
import { readWorkflowState } from "./workflow-state";

const keys = {
  production: "branch.master",
  development: "branch.develop",
  feature: "prefix.feature",
  release: "prefix.release",
  hotfix: "prefix.hotfix",
} as const;
const invalid = () =>
  new GitError({
    kind: "invalid-input",
    operation: t("flow.title"),
    message: errorText("flow.changed"),
  });
const pendingKey = async (cwd: string, id: string) =>
  "eda.gitflow-" +
  createHash("sha256")
    .update(JSON.stringify([await realpath(cwd), id]))
    .digest("hex") +
  ".pending";
function validateConfig(c: FlowConfig) {
  for (const b of [c.production, c.development]) assertValidRefName(b, t("flow.title"));
  for (const p of [c.feature, c.release, c.hotfix])
    assertValidRefName(p + "example", t("flow.title"));
  if (c.production === c.development || new Set([c.feature, c.release, c.hotfix]).size !== 3)
    throw invalid();
}
export async function readFlow(
  git: Pick<GitService, "readConfig">,
  cwd: string,
  profile: string,
): Promise<FlowState> {
  const values = Object.fromEntries(
    await Promise.all(
      Object.entries(keys).map(async ([key, part]) => [
        key,
        await git.readConfig("gitflow." + part, { cwd, scope: "local" }),
      ]),
    ),
  );
  const raw = await git.readConfig(await pendingKey(cwd, profile), { cwd, scope: "local" });
  const pending: unknown = raw ? JSON.parse(raw) : null;
  if (pending !== null && !isFlowPlan(pending)) throw invalid();
  return { config: isFlowConfig(values) ? values : null, pending };
}

export async function runFlow(
  git: GitService,
  cwd: string,
  identity: Identity,
  action: FlowAction,
): Promise<FlowPlan | null> {
  const { config, pending } = await readFlow(git, cwd, identity.id);
  const operation = t("flow.title"),
    opts = { cwd, operation };
  const ref = async (name: string) =>
    (
      await git.exec(["rev-parse", "--verify", "--end-of-options", name + "^{commit}"], opts)
    ).stdout.trim();
  const key = await pendingKey(cwd, identity.id);
  const save = async (plan: FlowPlan) => {
    await git.exec(["config", "--local", key, JSON.stringify(plan)], opts);
  };
  if (action.kind === "configure") {
    if (pending) throw invalid();
    const c = action.config;
    validateConfig(c);
    const base = await ref("refs/heads/" + c.production);
    if (
      (
        await git.exec(["show-ref", "--verify", "--quiet", "refs/heads/" + c.development], {
          ...opts,
          allowedExitCodes: [0, 1],
        })
      ).exitCode
    )
      await git.createBranch(cwd, c.development, { startPoint: base });
    await withLocalConfiguration(git, cwd, operation, async (file) => {
      for (const k of Object.keys(keys) as (keyof FlowConfig)[])
        await git.exec(["config", "--file", file, "gitflow." + keys[k], c[k]], opts);
    });
    return null;
  }
  if (!config) throw invalid();
  validateConfig(config);
  const status = await git.status(cwd);
  if (status.changes.length || (await readWorkflowState(git, cwd, status))) throw invalid();
  if (action.kind === "start" || action.kind === "preview" || action.kind === "finish") {
    if (pending) throw invalid();
    const item = action.kind === "finish" ? action.plan : action;
    const kind = "type" in item ? item.type : item.kind;
    assertValidRefName(item.name, operation);
    const branch = config[kind] + item.name;
    assertValidRefName(branch, operation);
    if (branch === config.production || branch === config.development) throw invalid();
    if (action.kind === "start") {
      const base = await ref(
        "refs/heads/" + (kind === "hotfix" ? config.production : config.development),
      );
      await git.createBranch(cwd, branch, { startPoint: base, checkout: true });
      return null;
    }
    const oid = await ref("refs/heads/" + branch);
    const targets = await Promise.all(
      (kind === "feature" ? [config.development] : [config.production, config.development]).map(
        async (name) => ({ name, before: await ref("refs/heads/" + name) }),
      ),
    );
    const tag = kind === "feature" ? null : item.name;
    if (
      tag &&
      !(
        await git.exec(["show-ref", "--verify", "--quiet", "refs/tags/" + tag], {
          ...opts,
          allowedExitCodes: [0, 1],
        })
      ).exitCode
    )
      throw invalid();
    const plan = { kind, name: item.name, branch, oid, targets, tag, retain: item.retain };
    if (action.kind === "preview") return plan;
    if (action.kind !== "finish" || JSON.stringify(action.plan) !== JSON.stringify(plan))
      throw invalid();
    await save(plan);
  } else if (!pending) throw invalid();
  const plan = action.kind === "finish" ? action.plan : pending;
  if (!plan) throw invalid();
  if (action.kind === "retain") {
    await git.exec(["config", "--local", "--unset", key], opts);
    return null;
  }
  const env = {
    overrides: {
      GIT_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no",
      GIT_AUTHOR_NAME: identity.gitName,
      GIT_AUTHOR_EMAIL: identity.gitEmail,
      GIT_COMMITTER_NAME: identity.gitName,
      GIT_COMMITTER_EMAIL: identity.gitEmail,
    },
    ...(identity.sshKeyPath && { sshKeyPath: identity.sshKeyPath }),
  };
  const configArgs = Object.entries(commitGitConfig(identity)).flatMap(([k, v]) => [
    "-c",
    k + "=" + v,
  ]);
  const sourceExists = !(
    await git.exec(["show-ref", "--verify", "--quiet", "refs/heads/" + plan.branch], {
      ...opts,
      allowedExitCodes: [0, 1],
    })
  ).exitCode;
  if (sourceExists && (await ref("refs/heads/" + plan.branch)) !== plan.oid) throw invalid();
  for (const target of plan.targets) {
    assertValidRefName(target.name, operation);
    const tip = await ref("refs/heads/" + target.name);
    const merged = !(
      await git.exec(["merge-base", "--is-ancestor", plan.oid, tip], {
        ...opts,
        allowedExitCodes: [0, 1],
      })
    ).exitCode;
    if (tip !== target.before) {
      const parents = (await git.exec(["show", "-s", "--format=%P", tip], opts)).stdout.trim();
      if (parents !== target.before + " " + plan.oid) throw invalid();
    }
    if (!sourceExists && !merged) throw invalid();
    await git.checkoutBranch(cwd, target.name);
    if (!merged)
      await git.exec(
        [...configArgs, "merge", "--no-ff", "--no-edit", "--no-overwrite-ignore", plan.oid],
        { ...opts, env },
      );
    if (plan.tag && target.name === config.production) {
      const tagRef = "refs/tags/" + plan.tag;
      const head = await ref("HEAD");
      const existing = await git.exec(["rev-parse", "--verify", tagRef], {
        ...opts,
        allowedExitCodes: [0, 128],
      });
      if (existing.exitCode)
        await git.exec(["update-ref", tagRef, head, "0".repeat(head.length)], opts);
      else if (existing.stdout.trim() !== head) throw invalid();
    }
  }
  if (!plan.retain && sourceExists) {
    if ((await ref("refs/heads/" + plan.branch)) !== plan.oid) throw invalid();
    await git.exec(["branch", "-d", "--", plan.branch], opts);
  }
  await git.exec(["config", "--local", "--unset", key], opts);
  return null;
}
