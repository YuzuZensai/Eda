import { t } from "@shared/i18n";
import { lazy, Suspense, type RefObject } from "react";
import type { Identity } from "@shared/identity/identity";
import { StateMessage } from "../../components/ui/index";
import type { SettingsSection } from "./settings-sections";
import { RepositorySyncSettings } from "./repository/RepositorySyncSettings";
import { CredentialsSettings } from "../credentials/CredentialsSettings";
import { ProfileGitSettings, RepositoryGitSettings } from "../profiles/ProfileGitSettings";
import { ProfileRepositoriesSettings } from "../profiles/ProfileRepositoriesSettings";
import { ProfilesSettings } from "../profiles/ProfilesSettings";
import { ScopedPreferences } from "./ScopedPreferences";
import { AccentSettings } from "./appearance/AccentSettings";
import { AppearanceControls } from "./appearance/AppearanceControls";
import { VigilantModeSettings } from "./appearance/VigilantModeSettings";
import { HistoryColumnsSettings } from "./appearance/HistoryColumnsSettings";
import { AboutSettings } from "./application/AboutSettings";
import { ApplicationPreferences } from "./application/ApplicationPreferences";
import { TerminalSettings } from "./application/TerminalSettings";
import { FailureSimulations } from "./debug/FailureSimulations";
import { AppDataSettings } from "./debug/AppDataSettings";
import { StateSimulations } from "./debug/StateSimulations";
import { FetchSettings } from "./git/FetchSettings";
import { GitEngineSettings } from "./git/GitEngineSettings";
import { SshAgentSettings } from "./git/SshAgentSettings";
import { HistorySettings } from "./git/HistorySettings";
import { ProviderConnections } from "../connections/ProviderConnections";

const ComponentGallery = lazy(() =>
  import("../../devtools/component-gallery/ComponentGallery").then((module) => ({
    default: module.ComponentGallery,
  })),
);

export function SettingsContent({
  section,
  profile,
  repositoryId,
  syncAnchors,
}: {
  section: SettingsSection;
  profile: Identity | null;
  repositoryId: string | undefined;
  syncAnchors: RefObject<Partial<Record<SettingsSection, HTMLElement>>>;
}) {
  switch (section) {
    case "profiles":
      return <ProfilesSettings />;
    case "global":
    case "preferences": {
      if (section === "preferences" && !profile)
        return (
          <p className="text-sm text-text-secondary">
            {t("settings.chooseAProfileToEditItsPreferences")}
          </p>
        );

      const owner = section === "global" ? "application" : "profile";
      const preview = owner === "application";

      return (
        <div className="space-y-6">
          <ScopedPreferences owner={owner} section="appearance" preview={preview} />
          <AccentSettings owner={owner} preview={preview} />
          <AppearanceControls owner={owner} preview={preview} active />
          <HistoryColumnsSettings key={`${owner}:${profile?.id}`} owner={owner} />
          <VigilantModeSettings key={`vigilant:${owner}:${profile?.id}`} owner={owner} />
        </div>
      );
    }
    case "global-git":
      return (
        <div className="space-y-6">
          <ScopedPreferences owner="application" section="git" />
          <GitEngineSettings />
          <SshAgentSettings />
          <FetchSettings />
          <HistorySettings />
        </div>
      );
    case "application":
      return <ApplicationPreferences />;
    case "about":
      return <AboutSettings />;
    case "workspace-application":
      return profile ? (
        <ApplicationPreferences key={profile.id} owner="profile" />
      ) : (
        <p className="text-sm text-text-secondary">
          {t("settings.chooseAProfileToEditItsApplicationPreferences")}
        </p>
      );
    case "terminal":
      return profile ? (
        <TerminalSettings key={profile.id} />
      ) : (
        <p className="text-sm text-text-secondary">
          {t("settings.chooseAProfileToEditItsPreferences")}
        </p>
      );
    case "git":
      return (
        <div className="space-y-6">
          {profile && <ScopedPreferences owner="profile" section="git" />}
          <ProfileGitSettings key={profile?.id ?? "none"} />
        </div>
      );
    case "repository-sync":
      return repositoryId && profile ? (
        <RepositorySyncSettings
          key={`${profile.id}:${repositoryId}`}
          repositoryId={repositoryId}
          anchors={syncAnchors}
        />
      ) : (
        <p className="text-sm text-text-secondary">
          {t("settings.chooseARepositoryToEditItsSyncSettings")}
        </p>
      );
    case "repository-git":
      return <RepositoryGitSettings />;
    case "repositories":
      return <ProfileRepositoriesSettings key={profile?.id ?? "none"} />;
    case "credentials":
      return <CredentialsSettings key={profile?.id ?? "none"} />;
    case "integrations":
      return profile ? (
        <ProviderConnections key={profile.id} profileId={profile.id} />
      ) : (
        <p className="text-sm text-text-secondary">{t("settings.selectAProfileToConnectGitHub")}</p>
      );
    case "debug":
      return (
        <Suspense
          fallback={<StateMessage tone="loading" title={t("settings.loadingComponents")} />}
        >
          <ComponentGallery />
        </Suspense>
      );
    case "debug-states":
      return <StateSimulations />;
    case "debug-failures":
      return <FailureSimulations />;
    case "debug-reset":
      return <AppDataSettings />;
    default:
      return null;
  }
}
