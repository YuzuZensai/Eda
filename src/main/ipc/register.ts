import { registerTerminalHandlers } from "./handlers/terminal-handlers";
import { registerConflictHandlers } from "./handlers/conflict-handlers";
import { registerWorkflowHandlers } from "./handlers/workflow-handlers";
import { registerStashHandlers } from "./handlers/stash-handlers";
import type { Services } from "../services";
import { registerApplicationHandlers } from "./handlers/application-handlers";
import { registerCredentialHandlers } from "./handlers/credential-handlers";
import { registerProfileHandlers } from "./handlers/profile-handlers";
import { registerRepositoryHandlers } from "./handlers/repository-handlers";
import { registerSessionHandlers } from "./handlers/session-handlers";
import { registerSettingsHandlers } from "./handlers/settings-handlers";
import { registerSshHandlers } from "./handlers/ssh-handlers";
import { registerOperationHandlers } from "./handlers/operation-handlers";
import { registerRemoteHandlers } from "./handlers/remote-handlers";
import { registerGitLabHandlers } from "./handlers/gitlab-handlers";
import { registerGitLabSelfHostedHandlers } from "./handlers/gitlab-self-hosted-handlers";
import { registerGitHubHandlers } from "./handlers/github-handlers";
import { registerUpdateHandlers } from "./handlers/update-handlers";

export function registerIpcHandlers(services: Services): void {
  registerTerminalHandlers(services);
  registerUpdateHandlers(services);
  registerGitHubHandlers(services);
  registerGitLabHandlers(services);
  registerGitLabSelfHostedHandlers(services);
  registerStashHandlers(services);
  registerWorkflowHandlers(services);
  registerConflictHandlers(services);
  registerRemoteHandlers(services);
  registerSessionHandlers(services);
  registerOperationHandlers(services);
  registerApplicationHandlers(services);
  registerProfileHandlers(services);
  registerRepositoryHandlers(services);
  registerSshHandlers(services);
  registerCredentialHandlers(services);
  registerSettingsHandlers(services);
}
