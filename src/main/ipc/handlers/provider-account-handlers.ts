import { GITHUB_VERIFICATION_URL } from "../../providers/github-auth";
import { clipboard } from "electron";
import { ok } from "@shared/errors";
import { t } from "@shared/i18n";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Services } from "../../services";
import { captureProfile, profileOperation } from "../profile-context";
import { handle } from "../transport";
import { optionalInteger, requireBoolean, requireId } from "../validate";

export async function profileWithAvatar<T extends { id: string; avatarUrl: string | null }>(
  avatars: Services["avatars"],
  provider: "github" | "gitlab",
  details: T | null,
) {
  if (!details) return null;
  const { avatarUrl, ...profile } = details;
  const image = await avatars.getProviderImage(provider, details.id, avatarUrl);
  return { ...profile, avatarDataUrl: image.dataUrl };
}

function registerProviderAccountHandlers(services: Services, provider: "github" | "gitlab") {
  const api = services[provider];
  const work = profileOperation(
    services,
    provider === "github" ? "main.githubHandlers.gitHubSignIn" : "main.gitlabHandlers.gitLabSignIn",
  );

  handle(IPC_CHANNELS[`${provider}Profile`], async (_event, profile) =>
    work(profile, async (id) =>
      profileWithAvatar(services.avatars, provider, await api.profile(id)),
    ),
  );

  handle(IPC_CHANNELS[`${provider}Repositories`], async (_event, profile, rawPage) => {
    const page = optionalInteger(rawPage, t("fields.repositoryPage"), 1, 10000) ?? 1;
    return work(profile, (id) => api.repositories(id, page));
  });

  handle(IPC_CHANNELS[`${provider}Status`], async (_event, profile) =>
    work(profile, (id) => api.status(id)),
  );

  handle(IPC_CHANNELS[`${provider}OpenProfile`], async (_event, profile, rawCopyUrl = false) => {
    const copyUrl = requireBoolean(rawCopyUrl, t("common.copyUrl"));
    return work(profile, async (id) => {
      const url = api.profileUrl(id);
      if (copyUrl) clipboard.writeText(url);
      else await services.browser.open(url, id);
    });
  });

  handle(IPC_CHANNELS[`${provider}Begin`], async (_event, profile) =>
    work(profile, (id) => api.begin(id)),
  );

  handle(IPC_CHANNELS[`${provider}Poll`], async (_event, profile, rawId) => {
    const id = requireId(rawId);
    return work(profile, async (owner) => api.poll(owner, id));
  });

  handle(IPC_CHANNELS[`${provider}Cancel`], async (_event, profile, rawId) => {
    const id = requireId(rawId);
    const captured = captureProfile(services.identity, requireId(profile));
    api.cancel(captured.id, id);
    return ok(undefined);
  });

  handle(IPC_CHANNELS[`${provider}SelectAccount`], async (_event, profile, account) =>
    work(profile, (id) => api.selectAccount(id, requireId(account))),
  );

  handle(IPC_CHANNELS[`${provider}Disconnect`], async (_event, profile) =>
    work(profile, (id) => api.disconnect(id)),
  );

  return work;
}

export function registerGitHubHandlers(services: Services): void {
  const { github } = services;

  handle(IPC_CHANNELS.githubMaintainerProfile, async () =>
    ok(await profileWithAvatar(services.avatars, "github", await github.maintainerProfile())),
  );

  const work = registerProviderAccountHandlers(services, "github");
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
          await services.browser.open(GITHUB_VERIFICATION_URL, owner);
        }
      });
    },
  );
}

export function registerGitLabHandlers(services: Services): void {
  const { gitlab } = services;
  const work = registerProviderAccountHandlers(services, "gitlab");
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
}
