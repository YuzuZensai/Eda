import { errorText } from "@shared/error-codes";
import { invalidRequest } from "../request-errors";
import type { ImagePreviewRequest } from "@shared/repository/image-preview";
import { buildGitEnvironment } from "../git/execution/environment";
import type { NodeProcessRunner } from "../git/execution/node-process-runner";
import type { GitService } from "../git/git-service";
import { runExternalDiff } from "../git/operations/external-diff";
import type { OperationManager } from "../operations/operation-manager";
import type { SettingsRepository } from "../persistence/settings-repository";
import type { RepositoryManager } from "./lifecycle/repository-manager";
import { readDiffToolFiles } from "./working-tree/image-preview";

export class RepositoryExternalTools {
  private readonly activeDiffTools = new Set<string>();

  constructor(
    private readonly runner: Pick<NodeProcessRunner, "run" | "launch">,
    private readonly git: GitService,
    private readonly repositories: Pick<
      RepositoryManager,
      "resolveActiveRepository" | "assertCurrentRepository"
    >,
    private readonly preferences: Pick<SettingsRepository, "resolve">,
    private readonly operations: Pick<OperationManager, "signal">,
  ) {}

  async openEditor(directory: string, profileId: string, target = directory) {
    const editor = this.preferences.resolve("editorExecutable", {
      profileId,
    }).value;

    if (!editor)
      throw invalidRequest(
        errorText("main.applicationHandlers.chooseAnEditorExecutableInApplicationSettingsFirst"),
      );

    try {
      await this.runner.launch(editor, [target], directory, buildGitEnvironment());
    } catch {
      throw invalidRequest(
        errorText("main.applicationHandlers.theConfiguredEditorCouldNotStartChooseIts"),
      );
    }
  }

  async openTerminal(directory: string, profileId: string) {
    const executable = this.preferences.resolve("terminalExecutable", {
      profileId,
    }).value;
    if (!executable) throw invalidRequest(errorText("worktrees.configureTerminal"));
    const env = buildGitEnvironment();
    for (const key of ["GIT_TERMINAL_PROMPT", "SSH_ASKPASS_REQUIRE", "LC_ALL", "LANG"])
      delete env[key];
    for (const key of [
      "LANG",
      "SHELL",
      "USER",
      "WAYLAND_DISPLAY",
      "DBUS_SESSION_BUS_ADDRESS",
      "XAUTHORITY",
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    await this.runner.launch(executable, [], directory, env);
  }

  async openDiff(selected: ImagePreviewRequest) {
    const repository = this.repositories.resolveActiveRepository(selected.repositoryId);
    const key = repository.id;
    if (this.activeDiffTools.has(key)) throw invalidRequest(errorText("externalDiff.busy"));
    const executable = this.preferences.resolve("diffExecutable", {
      profileId: repository.identityId,
    }).value;
    if (!executable) throw invalidRequest(errorText("externalDiff.choose"));
    const configured = this.preferences.resolve("diffTool", {
      profileId: repository.identityId,
    }).value;
    this.activeDiffTools.add(key);
    try {
      const versions = await readDiffToolFiles(this.git, repository.path, selected);
      await runExternalDiff(
        this.runner,
        executable,
        versions,
        () => this.repositories.assertCurrentRepository(repository),
        this.operations.signal,
        configured?.executable === executable ? configured.args : undefined,
      );
    } finally {
      this.activeDiffTools.delete(key);
    }
  }
}
