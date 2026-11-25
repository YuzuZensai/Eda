import { isUtf8 } from "node:buffer";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { PartialStagePreview, PartialStageRequest } from "@shared/repository/partial-stage";
import { createHash, randomUUID } from "node:crypto";
import type { GitService } from "../../git/git-service";
import { partialPatch } from "../../git/operations/partial-patch";
import { assertRepositoryPath } from "../../git/validation";
import { PreviewStore } from "../preview-store";

export class PartialStageService {
  private readonly previews = new PreviewStore<{
    profileId: string;
    repositoryId: string;
    root: string;
    request: PartialStageRequest;
    fingerprint: string;
    patch: string;
  }>(32);

  constructor(private readonly git: GitService) {}

  private async source(root: string, request: PartialStageRequest) {
    assertRepositoryPath(request.path, t("operations.partialStaging"));

    const status = await this.git.status(root);
    const change = status.changes.find((change) => change.path === request.path);

    if (!change || change.kind === "rename" || change.kind === "unmerged")
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.partialStaging"),
        message: errorText(
          "main.partialStageService.refreshTheFileRenamesAndConflictsRequireWholeFileActions",
        ),
      });

    const source =
      request.area === "unstaged" && change.kind === "untracked" ? "untracked" : request.area;
    const result = await this.git.partialDiff(
      root,
      request.path,
      source,
      t("operations.readPartialStagingSource"),
    );

    if (!isUtf8(result.stdoutBytes)) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.partialStaging"),
        message: errorText("main.partialStageService.partialStagingRequiresUtf8TextUseWholeFile"),
      });
    }

    const index = await this.git.exec(
      ["ls-files", "--stage", "-z", "--", `:(literal)${request.path}`],
      {
        cwd: root,
        operation: t("operations.readPartialStagingIndex"),
      },
    );

    return {
      raw: result.stdout,
      fingerprint: createHash("sha256")
        .update(result.stdoutBytes)
        .update(index.stdoutBytes)
        .digest("hex"),
    };
  }

  async preview(
    root: string,
    profileId: string,
    request: PartialStageRequest,
  ): Promise<PartialStagePreview> {
    const source = await this.source(root, request);
    const result = partialPatch(source.raw, request.path, request);

    await this.git.exec(["apply", "--cached", "--check", "--whitespace=nowarn", "-"], {
      cwd: root,
      operation: t("operations.checkPartialStaging"),
      stdin: result.patch,
    });

    const token = randomUUID();

    this.previews.set(token, {
      profileId,
      repositoryId: request.repositoryId,
      root,
      request: structuredClone(request),
      fingerprint: source.fingerprint,
      patch: result.patch,
    });

    return { token, ...result };
  }

  async apply(root: string, profileId: string, repositoryId: string, token: string): Promise<void> {
    const preview = this.previews.get(token);

    if (
      !preview ||
      preview.root !== root ||
      preview.profileId !== profileId ||
      preview.repositoryId !== repositoryId
    )
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.partialStaging"),
        message: errorText("main.partialStageService.thisPreviewExpiredOrBelongsToAnotherContext"),
      });

    this.previews.delete(token);

    const current = await this.source(root, preview.request);

    if (current.fingerprint !== preview.fingerprint)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.partialStaging"),
        message: errorText(
          "main.partialStageService.theFileOrIndexChangedAfterThePreviewRefreshAndPreviewAgain",
        ),
      });

    await this.git.exec(["apply", "--cached", "--whitespace=nowarn", "-"], {
      cwd: root,
      operation:
        preview.request.area === "staged"
          ? t("operations.unstageSelectedChanges")
          : t("operations.stageSelectedChanges"),
      stdin: preview.patch,
    });
  }
}
