import { errorText } from "@shared/error-codes";
import { clipboard, shell } from "electron";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Services } from "../../services";
import { handle } from "../transport";
import { captureProfile, profileOperation } from "../profile-context";
import { optionalInteger, requireBoolean, requireId, requireString } from "../validate";
import { invalidRequest } from "../request-errors";

export function registerGitLabSelfHostedHandlers(services: Services): void {
  const { identity, gitlabSelfHosted: gitlab } = services;

  const work = profileOperation(services, "operations.gitLabSignIn");

  const instance = (value: unknown) => requireString(value, t("fields.gitLabInstanceUrl"), 2048);

  handle(IPC_CHANNELS.gitlabSelfHostedStatus, async (_event, profile) =>
    work(profile, (id) => gitlab.status(id)),
  );

  handle(IPC_CHANNELS.gitlabSelfHostedProfile, async (_event, profile, url) => {
    const baseUrl = instance(url);

    return work(profile, async (id) => {
      const details = await gitlab.profile(id, baseUrl);
      if (!details) return null;
      const image = await services.avatars.getGitLab(details.id, details.avatarUrl);
      const { avatarUrl: _avatarUrl, ...accountProfile } = details;
      return { ...accountProfile, avatarDataUrl: image.dataUrl };
    });
  });

  handle(
    IPC_CHANNELS.gitlabSelfHostedConnect,
    async (_event, profile, url, token, rawIgnoreTlsErrors) => {
      const baseUrl = instance(url);
      const value = requireString(token, t("fields.personalAccessToken"), 4096);
      if (rawIgnoreTlsErrors !== undefined && typeof rawIgnoreTlsErrors !== "boolean")
        throw invalidRequest(errorText("main.providers.gitlabSelfHosted.invalidUrl"));

      return work(profile, (id) => gitlab.connect(id, baseUrl, value, rawIgnoreTlsErrors ?? false));
    },
  );

  handle(IPC_CHANNELS.gitlabSelfHostedCancel, async (_event, profile) => {
    const captured = captureProfile(identity, requireId(profile));

    gitlab.cancel(captured.id);

    return ok(undefined);
  });

  handle(IPC_CHANNELS.gitlabSelfHostedDisconnect, async (_event, profile, url) => {
    const baseUrl = instance(url);

    return work(profile, (id) => gitlab.disconnect(id, baseUrl));
  });

  handle(
    IPC_CHANNELS.gitlabSelfHostedOpenTokenSettings,
    async (_event, profile, url, rawForm, rawCopyUrl = false) => {
      const copyUrl = requireBoolean(rawCopyUrl, t("common.copyUrl"));
      const baseUrl = instance(url);
      const form = rawForm === undefined ? "legacy" : rawForm;

      if (form !== "legacy" && form !== "granular" && form !== "older")
        throw invalidRequest(errorText("main.providers.gitlabSelfHosted.invalidUrl"));

      return work(profile, async () => {
        const url = gitlab.tokenSettingsUrl(baseUrl, form);
        if (copyUrl) clipboard.writeText(url);
        else await shell.openExternal(url);
      });
    },
  );

  handle(
    IPC_CHANNELS.gitlabSelfHostedOpenProfile,
    async (_event, profile, url, rawCopyUrl = false) => {
      const baseUrl = instance(url);
      const copyUrl = requireBoolean(rawCopyUrl, t("common.copyUrl"));

      return work(profile, async (id) => {
        const url = gitlab.profileUrl(id, baseUrl);
        if (copyUrl) clipboard.writeText(url);
        else await shell.openExternal(url);
      });
    },
  );

  handle(IPC_CHANNELS.gitlabSelfHostedRepositories, async (_event, profile, url, rawPage) => {
    const baseUrl = instance(url);
    const page = optionalInteger(rawPage, t("fields.repositoryPage"), 1, 10000) ?? 1;

    return work(profile, (id) => gitlab.repositories(id, baseUrl, page));
  });
}
