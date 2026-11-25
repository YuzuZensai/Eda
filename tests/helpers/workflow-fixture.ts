import type { GitService } from "@main/git/git-service";
import { IdentityManager } from "@main/identity/identity-manager";
import { ContentRecoveryRepository } from "@main/persistence/content-recovery-repository";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import type { SettingsRepository } from "@main/persistence/settings-repository";
import type { Database } from "@main/persistence/types";
import { WorkflowJournal } from "@main/persistence/workflow-journal";
import { RepositoryManager } from "@main/repo/lifecycle/repository-manager";
import { WorkflowService } from "@main/repo/workflows/workflow-service";
import { RepositoryWriter } from "@main/repo/working-tree/repository-writer";

export function workflowFixture(
  db: Database,
  git: GitService,
  options: { recordWriterHistory?: boolean; settings?: SettingsRepository } = {},
) {
  const identities = new IdentityRepository(db);
  const identity = new IdentityManager(identities, git, options.settings);
  const repositories = new RepositoryManager(
    new RepositoryMemberships(db),
    git,
    identity,
    identities,
  );
  const journal = new WorkflowJournal(db);
  const recovery = new ContentRecoveryRepository(db);
  const writer = new RepositoryWriter(
    git,
    repositories,
    identity,
    identities,
    undefined,
    options.recordWriterHistory ? recovery : undefined,
    options.recordWriterHistory ? journal : undefined,
  );
  const workflows = new WorkflowService(git, repositories, writer, identity, journal, recovery);

  return { identities, identity, repositories, journal, recovery, writer, workflows };
}

export function activateTestProfile(identities: IdentityRepository) {
  const profile = identities.create({
    name: "Eda",
    gitName: "Eda",
    gitEmail: "test@eda.invalid",
    hue: 0,
    signing: { format: "none", signCommits: false },
  });
  identities.setActiveId(profile.id);
  return profile;
}
