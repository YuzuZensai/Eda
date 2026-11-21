import { t } from "@shared/i18n";
import { clipboard } from "electron";
import { ok } from "@shared/errors";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Services } from "../../services";
import { handle } from "../transport";
import { captureProfile, profileOperation } from "../profile-context";
import { optionalInteger, requireBoolean, requireId } from "../validate";

export function registerGitLabHandlers(services: Services): void {
  const { identity, gitlab } = services;
  const work = profileOperation(services, "main.gitlabHandlers.gitLabSignIn");

  handle(IPC_CHANNELS.gitlabProfile, async (_event, profile) =>
    work(profile, async (id) => {
      const details = await gitlab.profile(id);
      if (!details) return null;
      const image = await services.avatars.getGitLab(details.id, details.avatarUrl);
      const { avatarUrl: _avatarUrl, ...profile } = details;
      return { ...profile, avatarDataUrl: image.dataUrl };
    }),
  );

  handle(IPC_CHANNELS.gitlabRepositories, async (_event, profile, rawPage) => {
    const page = optionalInteger(rawPage, t("fields.repositoryPage"), 1, 10000) ?? 1;
    return work(profile, (id) => gitlab.repositories(id, page));
  });

  handle(IPC_CHANNELS.gitlabStatus, async (_event, profile) =>
    work(profile, (id) => gitlab.status(id)),
  );

  handle(IPC_CHANNELS.gitlabBegin, async (_event, profile) =>
    work(profile, (id) => gitlab.begin(id)),
  );

  handle(IPC_CHANNELS.gitlabPoll, async (_event, profile, rawId) => {
    const id = requireId(rawId);
    return work(profile, (owner) => gitlab.poll(owner, id));
  });

  handle(IPC_CHANNELS.gitlabCancel, async (_event, profile, rawId) => {
    const id = requireId(rawId);
    const captured = captureProfile(identity, requireId(profile));
    gitlab.cancel(captured.id, id);
    return ok(undefined);
  });

  handle(IPC_CHANNELS.gitlabSelectAccount, async (_event, profile, account) =>
    work(profile, (id) => gitlab.selectAccount(id, requireId(account))),
  );

  handle(IPC_CHANNELS.gitlabDisconnect, async (_event, profile) =>
    work(profile, (id) => gitlab.disconnect(id)),
  );

  handle(
    IPC_CHANNELS.gitlabOpenAuthorization,
    async (_event, profile, rawId, rawCopyUrl = false) => {
      const id = requireId(rawId);
      const copyUrl = requireBoolean(rawCopyUrl, t("common.copyUrl"));

      return work(profile, async (owner) => {
        const url = gitlab.authorizationUrl(owner, id);
        if (copyUrl) clipboard.writeText(url);
        else await services.browser.open(url, owner);
      });
    },
  );

  handle(IPC_CHANNELS.gitlabOpenProfile, async (_event, profile, rawCopyUrl = false) => {
    const copyUrl = requireBoolean(rawCopyUrl, t("common.copyUrl"));
    return work(profile, async (id) => {
      const url = gitlab.profileUrl(id);
      if (copyUrl) clipboard.writeText(url);
      else await services.browser.open(url, id);
    });
  });
}
