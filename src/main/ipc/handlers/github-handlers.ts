import { t } from "@shared/i18n";
import { clipboard, shell } from "electron";
import { ok } from "@shared/errors";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Services } from "../../services";
import { GITHUB_VERIFICATION_URL } from "../../providers/github-auth";
import { handle } from "../transport";
import { captureProfile, profileOperation } from "../profile-context";
import { optionalInteger, requireBoolean, requireId } from "../validate";

export function registerGitHubHandlers(services: Services): void {
  const { identity, github } = services;

  handle(IPC_CHANNELS.githubMaintainerProfile, async () => {
    const details = await github.maintainerProfile();

    if (!details) return ok(null);

    const avatar = await services.avatars.getGitHub(details.id, details.avatarUrl);

    const { avatarUrl: _avatarUrl, ...profile } = details;
    return ok({ ...profile, avatarDataUrl: avatar.dataUrl });
  });

  const work = profileOperation(services, "main.githubHandlers.gitHubSignIn");

  handle(IPC_CHANNELS.githubRepositories, async (_event, profile, rawPage) => {
    const page = optionalInteger(rawPage, t("fields.repositoryPage"), 1, 10000) ?? 1;
    return work(profile, (id) => github.repositories(id, page));
  });

  handle(IPC_CHANNELS.githubStatus, async (_event, profile) =>
    work(profile, (id) => github.status(id)),
  );

  handle(IPC_CHANNELS.githubProfile, async (_event, profile) =>
    work(profile, async (id) => {
      const details = await github.profile(id);
      if (!details) return null;
      const avatar = await services.avatars.getGitHub(details.id, details.avatarUrl);
      const { avatarUrl: _avatarUrl, ...profile } = details;
      return { ...profile, avatarDataUrl: avatar.dataUrl };
    }),
  );

  handle(IPC_CHANNELS.githubOpenProfile, async (_event, profile, rawCopyUrl = false) => {
    const copyUrl = requireBoolean(rawCopyUrl, t("common.copyUrl"));
    return work(profile, async (id) => {
      const url = github.profileUrl(id);
      if (copyUrl) clipboard.writeText(url);
      else await shell.openExternal(url);
    });
  });

  handle(IPC_CHANNELS.githubBegin, async (_event, profile) =>
    work(profile, (id) => github.begin(id)),
  );

  handle(IPC_CHANNELS.githubPoll, async (_event, profile, rawId) => {
    const id = requireId(rawId);
    return work(profile, (owner) => github.poll(owner, id));
  });

  handle(IPC_CHANNELS.githubCancel, async (_event, profile, rawId) => {
    const id = requireId(rawId);
    const captured = captureProfile(identity, requireId(profile));
    github.cancel(captured.id, id);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.githubDisconnect, async (_event, profile) =>
    work(profile, (id) => github.disconnect(id)),
  );

  handle(
    IPC_CHANNELS.githubOpenVerification,
    async (_event, profile, rawId, rawCopyUrl = false) => {
      const id = requireId(rawId);
      const copyUrl = requireBoolean(rawCopyUrl, t("common.copyUrl"));

      return work(profile, async (owner) => {
        const userCode = github.verifyPending(owner, id);
        if (copyUrl) clipboard.writeText(GITHUB_VERIFICATION_URL);
        else {
          clipboard.writeText(userCode);
          await shell.openExternal(GITHUB_VERIFICATION_URL);
        }
      });
    },
  );
}
