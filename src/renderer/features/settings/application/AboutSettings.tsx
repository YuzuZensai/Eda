import appIcon from "../../../assets/branding/Eda-icon.svg";
import { PACKAGE_MANAGER_NAMES, type InstallationInfo } from "@shared/application";
import { t, type MessageKey } from "@shared/i18n";
import {
  MAINTAINER_EMAIL,
  MAINTAINER_GITHUB_LOGIN,
  type GitHubAccountProfile,
} from "@shared/integrations/github";
import { UPDATE_DOWNLOAD_PAGE } from "@shared/updates";
import {
  HeartIcon as Heart,
  MailIcon as Mail,
  RotateCcwIcon as RotateCcw,
  StarIcon as Star,
} from "../../../components/ui/icons";
import { useEffect, useState } from "react";
import { Button, Checkbox, CopyButton, ExternalLinkButton } from "../../../components/ui/index";
import { usePreferencesStore } from "../../../stores/preferences-store";
import { useShellStore } from "../../../stores/shell-store";
import { useSimulationStore } from "../../../stores/simulation-store";
import { ConnectionProfile } from "../../connections/ConnectionProfile";
import { ProviderIcon } from "../../connections/ProviderIcon";
import { UpdatesSettings } from "../../updates/UpdatesSettings";

const maintainer = MAINTAINER_GITHUB_LOGIN;
const maintainerEmail = MAINTAINER_EMAIL;
const repositoryUrl = `https://github.com/${maintainer}/Eda`;
const installationKeys = {
  development: "settings.aboutSettings.installationDevelopment",
  direct: "settings.aboutSettings.installationDirect",
  homebrew: "settings.aboutSettings.installationHomebrew",
  unknown: "aboutSettings.unknown",
} as const satisfies Record<Exclude<InstallationInfo["method"], "system-package">, MessageKey>;

export function AboutSettings() {
  const developerSettingsEnabled = usePreferencesStore(
    (state) => state.values.developerSettingsEnabled.value,
  );
  const busy = usePreferencesStore((state) => state.loading || state.saving);
  const build = window.eda.app.version;
  const simulatedInstallation = useSimulationStore((state) =>
    state.update ? state.updateInstallation : null,
  );
  const [detectedInstallation, setInstallation] = useState<InstallationInfo | null>(null);
  const [profile, setProfile] = useState<GitHubAccountProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const installation: InstallationInfo | null = simulatedInstallation
    ? simulatedInstallation === "direct" || simulatedInstallation === "homebrew"
      ? { method: simulatedInstallation }
      : { method: "system-package", manager: simulatedInstallation }
    : detectedInstallation;

  useEffect(() => {
    let active = true;

    void window.eda.app
      .installation()
      .then((result) => {
        if (active) setInstallation(result.ok ? result.value : { method: "unknown" });
      })
      .catch(() => {
        if (active) setInstallation({ method: "unknown" });
      });

    void window.eda.github
      .maintainerProfile()
      .then((result) => {
        if (active && result.ok) setProfile(result.value);
      })
      .catch(() => {
        if (active) setProfile(null);
      })
      .finally(() => {
        if (active) setLoadingProfile(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <section aria-labelledby="about-eda-heading" className="space-y-4">
        <div className="flex items-center gap-4">
          <img src={appIcon} width={64} height={64} alt="" className="shrink-0" draggable={false} />

          <div className="min-w-0">
            <h2 id="about-eda-heading" className="text-2xl font-semibold tracking-tight">
              {t("settings.aboutSettings.eda")}
            </h2>

            <p className="mt-2 text-sm text-text-secondary">
              {t("settings.aboutSettings.aModernOpenSourceGitClient")}
            </p>
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2.5 text-xs">
          <div className="min-w-0">
            <dt className="text-text-tertiary">{t("settings.aboutSettings.version")}</dt>
            <dd className="flex min-h-8 items-center gap-1">
              <span className="selectable min-w-0 font-mono [overflow-wrap:anywhere]">
                {build.displayVersion}
              </span>

              <CopyButton
                value={build.displayVersion}
                label={t("settings.aboutSettings.copyEdaVersion")}
              />
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-tertiary">{t("settings.aboutSettings.commit")}</dt>
            <dd className="flex min-h-8 items-center gap-1">
              {build.commit ? (
                <>
                  <span className="selectable font-mono" title={build.commit}>
                    {build.commit.slice(0, 12)}
                  </span>

                  <CopyButton
                    value={build.commit}
                    label={t("settings.aboutSettings.copyBuildCommit")}
                  />
                </>
              ) : (
                <span className="text-text-secondary">{t("aboutSettings.unavailable")}</span>
              )}
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-tertiary">{t("settings.aboutSettings.sourceState")}</dt>
            <dd
              className="flex min-h-8 items-center"
              title={
                build.dirty === null
                  ? t("settings.aboutSettings.sourceMetadataWasUnavailableWhenThisBuildWasCreated")
                  : t("settings.aboutSettings.capturedWhenThisBuildWasCreated")
              }
            >
              <span>
                {build.dirty === null
                  ? t("aboutSettings.unknown")
                  : build.dirty
                    ? t("aboutSettings.localChangesDirty")
                    : t("aboutSettings.clean")}
              </span>
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-text-tertiary">{t("settings.aboutSettings.installation")}</dt>
            <dd className="flex min-h-8 items-center" aria-busy={installation === null}>
              {installation
                ? installation.method === "system-package"
                  ? t("settings.aboutSettings.installationSystemPackage", {
                      manager: PACKAGE_MANAGER_NAMES[installation.manager],
                    })
                  : t(installationKeys[installation.method])
                : t("settings.aboutSettings.detectingInstallation")}
            </dd>
          </div>
        </dl>
      </section>

      <div className="space-y-3">
        <section
          aria-labelledby="about-maintainer-heading"
          className="flex flex-wrap items-stretch gap-4"
        >
          <div className="min-w-0 flex-1 basis-64 space-y-3 rounded-md border border-border-subtle bg-bg-surface p-4">
            <h2
              id="about-maintainer-heading"
              className="flex items-center gap-2 text-sm font-medium"
            >
              <ProviderIcon provider="GitHub" />
              {t("settings.aboutSettings.maintainer")}
            </h2>

            <div className="min-h-32" aria-busy={loadingProfile}>
              <ConnectionProfile
                loading={loadingProfile}
                login={profile?.login ?? maintainer}
                name={profile?.name ?? t("settings.aboutSettings.yuzu")}
                bio={profile?.bio}
                location={profile?.location}
                avatarDataUrl={profile?.avatarDataUrl}
                hue={45}
                profileLabel={t("settings.gitHubConnection.viewOnGitHub", {
                  login: profile?.login ?? maintainer,
                })}
                profileLink={{ href: `https://github.com/${maintainer}` }}
              >
                <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
                  <Mail size={14} aria-hidden="true" className="shrink-0" />

                  <span className="selectable min-w-0 [overflow-wrap:anywhere]">
                    {maintainerEmail}
                  </span>

                  <span className="-my-1 inline-flex shrink-0">
                    <CopyButton
                      value={maintainerEmail}
                      label={t("settings.aboutSettings.copyMaintainerEmail")}
                      size="icon-xs"
                    />
                  </span>
                </div>
              </ConnectionProfile>
            </div>
          </div>

          <div className="min-w-0 flex-1 basis-64 space-y-3 rounded-md border border-[var(--sponsor-bg)] bg-bg-surface p-4">
            <div>
              <h3 className="text-sm font-medium text-text-primary">
                {t("settings.aboutSettings.supportEda")}
              </h3>

              <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                {t("settings.aboutSettings.sponsorYuzuToHelpKeepEdaGrowingAndFreelyAvailable")}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <ExternalLinkButton
                href={`https://github.com/sponsors/${maintainer}`}
                variant="primary"
                size="md"
                block
                trailingIcon
                className="bg-[var(--sponsor-bg)]! text-white!"
                icon={<Heart size={16} aria-hidden="true" className="ui-heartbeat fill-current" />}
              >
                {t("settings.aboutSettings.sponsorOnGitHub")}
              </ExternalLinkButton>

              <ExternalLinkButton
                href={repositoryUrl}
                variant="secondary"
                size="md"
                block
                trailingIcon
                icon={<Star size={16} aria-hidden="true" />}
              >
                {t("settings.aboutSettings.starTheRepo")}
              </ExternalLinkButton>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap gap-2">
          <ExternalLinkButton href="https://eda.kirameki.cafe">
            {t("settings.aboutSettings.website")}
          </ExternalLinkButton>

          <ExternalLinkButton href={repositoryUrl}>
            {t("settings.aboutSettings.sourceCode")}
          </ExternalLinkButton>

          <ExternalLinkButton href={UPDATE_DOWNLOAD_PAGE}>
            {t("settings.updatesSettings.downloadPage")}
          </ExternalLinkButton>
        </div>
      </div>

      <UpdatesSettings />

      <section
        aria-labelledby="about-tour-heading"
        className="space-y-4 border-t border-border-subtle pt-6"
      >
        <h2 id="about-tour-heading" className="text-sm font-medium">
          {t("settings.aboutSettings.guidedTour")}
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border-subtle bg-bg-surface p-4">
          <p className="min-w-0 flex-1 basis-64 text-xs leading-relaxed text-text-secondary">
            {t("settings.aboutSettings.guidedTourDescription")}
          </p>
          <Button
            variant="secondary"
            icon={<RotateCcw size={14} aria-hidden="true" />}
            onClick={() => useShellStore.getState().startTour()}
          >
            {t("settings.aboutSettings.takeTheTourAgain")}
          </Button>
        </div>
      </section>

      <section
        aria-labelledby="about-license-heading"
        className="space-y-3 border-t border-border-subtle pt-6"
      >
        <h2 id="about-license-heading" className="text-sm font-medium">
          {t("settings.aboutSettings.license")}
        </h2>

        <p className="text-sm text-text-secondary">
          {t("settings.aboutSettings.edaIsFreeSoftwareLicensedUnderTheGnu")}
        </p>

        <p className="text-xs text-text-tertiary">
          {t("settings.aboutSettings.youCanUseStudyShareAndModifyEda")}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <ExternalLinkButton href={`${repositoryUrl}/blob/main/LICENSE`}>
            {t("settings.aboutSettings.readTheLicense")}
          </ExternalLinkButton>
          <Button
            variant="ghost"
            size="sm"
            disabled
            title={t("settings.aboutSettings.thirdPartyNoticesAreComingSoon")}
          >
            <span>{t("settings.aboutSettings.thirdPartyNotices")}</span>
            <span className="rounded-sm border border-border-subtle px-1.5 py-0.5 text-xs">
              {t("settings.aboutSettings.comingSoon")}
            </span>
          </Button>
        </div>
      </section>
      <section
        aria-labelledby="about-developer-settings-heading"
        className="space-y-3 border-t border-border-subtle pt-6"
      >
        <h2 id="about-developer-settings-heading" className="text-sm font-medium">
          {t("settings.aboutSettings.developerSettings")}
        </h2>
        <Checkbox
          checked={developerSettingsEnabled}
          disabled={busy}
          onChange={(event) =>
            void usePreferencesStore
              .getState()
              .set("developerSettingsEnabled", { kind: "application" }, event.currentTarget.checked)
          }
        >
          {t("settings.aboutSettings.enableDeveloperSettings")}
        </Checkbox>
        <p className="text-xs text-text-tertiary">
          {t("settings.aboutSettings.developerSettingsDescription")}
        </p>
      </section>
    </div>
  );
}
