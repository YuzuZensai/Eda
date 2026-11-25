import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type {
  DuplicateProfileOptions,
  ProfileDeletePreview,
} from "@shared/identity/profile-session";
import { createHash } from "node:crypto";
import type { IdentityRepository } from "../persistence/identity-repository";
import type { ProfileSessionRepository } from "../persistence/profile-session-repository";
import type { ProfileRepository } from "../persistence/profile-repository";
import type { SecretStore } from "../secrets/secret-store";
import type { IdentityManager } from "./identity-manager";

export class ProfileService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly identities: IdentityRepository,
    private readonly identity: IdentityManager,
    private readonly sessions: ProfileSessionRepository,
    private readonly secrets: SecretStore,
  ) {}

  assignRepository(repositoryId: string, targetProfileId: string, move: boolean): Promise<string> {
    const owner = this.identity.getActive()?.id;

    if (!owner || owner === targetProfileId)
      throw invalid(errorText("main.identity.profileService.chooseADifferentDestinationProfile"));

    return this.identity.serialize(async () =>
      this.profiles.assignRepository(repositoryId, owner, targetProfileId, move),
    );
  }

  duplicate(id: string, options: DuplicateProfileOptions) {
    return this.identity.serialize(async () => this.profiles.duplicate(id, options));
  }

  previewDelete(id: string): ProfileDeletePreview {
    const profile = this.identities.findById(id);

    if (!profile)
      throw invalid(errorText("main.identity.profileService.thatProfileNoLongerExists"));

    const active = this.identity.getActive()?.id === id;
    const fallback = active ? this.identities.list().find((item) => item.id !== id) : undefined;
    const { rows, drafts, state, overrides, recovery, contentSnapshots } =
      this.profiles.snapshot(id);
    const token = createHash("sha256")
      .update(
        JSON.stringify({
          profile,
          rows,
          drafts,
          state,
          overrides,
          recovery,
          contentSnapshots,
          active,
          fallback,
        }),
      )
      .digest("hex");

    return {
      profileId: id,
      name: profile.name,
      active,
      repositories: rows.length,
      drafts: drafts.length,
      fallback: fallback ? { id: fallback.id, name: fallback.name } : null,
      token,
    };
  }

  async delete(id: string, token: string): Promise<void> {
    const checkPreview = () => {
      const preview = this.previewDelete(id);
      if (preview.token !== token)
        throw invalid(
          errorText(
            "main.identity.profileService.theProfileChangedAfterThePreviewReviewTheUpdatedDeletionPreview",
          ),
        );

      return preview;
    };
    const preview = checkPreview();
    if (preview.fallback) this.sessions.read(preview.fallback.id, "primary");

    await this.identity.replaceAfterDelete(id, preview.fallback?.id ?? null, async () => {
      checkPreview();
      await this.secrets.deleteForIdentity(id);

      try {
        // Other windows can still save drafts while the vault is being cleared.
        if (this.previewDelete(id).token === token) {
          this.profiles.delete(id, preview.active, preview.fallback?.id ?? null);
          return;
        }
      } catch {
        throw invalid(
          errorText(
            "main.identity.profileService.rememberedCredentialsWereRemovedButProfileMetadataCould",
          ),
        );
      }

      throw invalid(errorText("main.identity.profileService.profileChangedDuringVaultCleanup"));
    });
  }
}

function invalid(message: ErrorText): GitError {
  return new GitError({ kind: "invalid-input", operation: t("operations.manageProfile"), message });
}
