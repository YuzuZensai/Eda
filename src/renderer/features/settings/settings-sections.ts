import { t } from "@shared/i18n";
import {
  FlaskConicalIcon as FlaskConical,
  FolderGit2Icon as FolderGit2,
  BranchIcon as GitBranch,
  InfoIcon as Info,
  KeyRoundIcon as KeyRound,
  MonitorIcon as Monitor,
  PaletteIcon as Palette,
  PanelsTopLeftIcon as PanelsTopLeft,
  PlugIcon as Plug,
  SlidersHorizontalIcon as SlidersHorizontal,
  DatabaseIcon as Database,
  UsersRoundIcon as UsersRound,
  type LucideIcon,
} from "../../components/ui/icons";

export type SettingsSection =
  | "profiles"
  | "preferences"
  | "repositories"
  | "credentials"
  | "global-git"
  | "global"
  | "application"
  | "about"
  | "workspace-application"
  | "terminal"
  | "git"
  | "repository-sync"
  | "repository-fetch"
  | "repository-remotes"
  | "repository-pull"
  | "repository-git"
  | "integrations"
  | "debug"
  | "debug-states"
  | "debug-failures"
  | "debug-reset";

export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  title: string;
  description: string;
  icon: LucideIcon;
  group: "global" | "profile" | "repository" | "debug";
  keywords: string;
}[] = [
  {
    id: "global",
    keywords: t("settings.globalThemeAppearanceDarkLightAccentColorTint"),
    title: t("settings.appearance"),
    description: t("settings.chooseThemesAccentColorInterfaceScaleAndMotion"),
    icon: Palette,
    group: "global",
  },
  {
    id: "profiles",
    keywords: t("settings.nameEmailAuthorIdentityAvatarDuplicateDelete"),
    title: t("settings.profiles"),
    description: t("settings.manageCommitIdentitiesRepositoryAccessAndSavedSessions"),
    icon: UsersRound,
    group: "global",
  },
  {
    id: "application",
    keywords: t("settings.app.keywords"),
    title: t("settings.application"),
    description: t("settings.app.hint"),
    icon: Monitor,
    group: "global",
  },
  {
    id: "global-git",
    keywords: t("settings.globalFetchBackgroundIntervalGitSyncAuthorSigning"),
    title: t("settings.git"),
    description: t("settings.configureGitSynchronizationAndTheGitInstallationUsedByEda"),
    icon: GitBranch,
    group: "global",
  },
  {
    id: "about",
    keywords: `${t("settings.versionBuildCommitHashDirtyMaintainerYuzuZensai")} ${t("settings.aboutSettings.developerSettings")}`,
    title: t("settings.about"),
    description: t("settings.versionInformationThePeopleBehindEdaAndItsLicense"),
    icon: Info,
    group: "global",
  },
  {
    id: "preferences",
    keywords: t("settings.profileWorkspaceThemeAppearanceDarkLightNordAccent"),
    title: t("settings.appearance"),
    description: t("settings.customizeThemesAccentColorScaleAndMotionForThisProfile"),
    icon: Palette,
    group: "profile",
  },
  {
    id: "workspace-application",
    keywords: t("settings.app.profileKeywords"),
    title: t("settings.application"),
    description: t("settings.app.profileHint"),
    icon: Monitor,
    group: "profile",
  },
  {
    id: "terminal",
    keywords: `${t("terminal.font")} ${t("terminal.cursor")} ${t("terminal.scrollback")}`,
    title: t("terminal.title"),
    description: t("terminal.settingsDescription"),
    icon: Monitor,
    group: "profile",
  },
  {
    id: "repositories",
    keywords: t("settings.membershipShareMoveFolderProfileRepository"),
    title: t("settings.repositories"),
    description: t("settings.manageTheLocalRepositoryFoldersListedInThisProfile"),
    icon: FolderGit2,
    group: "profile",
  },
  {
    id: "credentials",
    keywords: t("settings.sShgpgSigningKeyPassphraseFingerprintAgentGenerate"),
    title: t("settings.credentialsSigning"),
    description: t("settings.sshKeysAndCommitSigningForTheActiveProfile"),
    icon: KeyRound,
    group: "profile",
  },
  {
    id: "git",
    keywords: t("settings.profileAuthorEmailNameSigningSyncGitconfigScope"),
    title: t("settings.git"),
    description: t("settings.manageThisProfileSGitIdentityGlobalSynchronization"),
    icon: GitBranch,
    group: "profile",
  },
  {
    id: "integrations",
    keywords: t("settings.providerAccountGitHubGitLabBitbucketAzureTokenProfileOffline"),
    title: t("settings.integrations"),
    description: t("settings.gitHostConnections"),
    icon: Plug,
    group: "profile",
  },
  {
    id: "repository-sync",
    title: t("settings.sync"),
    description: t("settings.manageRemotesBackgroundFetchAndPullBehaviorForThisRepository"),
    icon: GitBranch,
    group: "repository",
    keywords: t("settings.fetchBackgroundIntervalPruneTagsAutomaticRemotesOrigin"),
  },
  {
    id: "repository-git",
    keywords: t("settings.repositoryCommitLocalFolderCheckoutAuthorEmailName"),
    title: t("settings.commit"),
    description: t("settings.configureCommitIdentityAndSigningForTheSelectedRepository"),
    icon: GitBranch,
    group: "repository",
  },
  {
    id: "debug",
    keywords: t("settings.debugComponentsGalleryDesignSystemControlsButtonsInputs"),
    title: t("settings.components"),
    description: t("settings.previewTheSharedInterfaceComponentsAndTheirInteractionStates"),
    icon: PanelsTopLeft,
    group: "debug",
  },
  {
    id: "debug-states",
    keywords: t("settings.stateSimulations.keywords"),
    title: t("settings.stateSimulations.title"),
    description: t("settings.stateSimulations.sectionDescription"),
    icon: SlidersHorizontal,
    group: "debug",
  },
  {
    id: "debug-failures",
    keywords: t("settings.debugResilienceTestSimulateCrashRuntimeErrorPromise"),
    title: t("settings.resilienceTesting"),
    description: t("settings.triggerErrorsAndCrashesToTestDiagnosticsAndRecovery"),
    icon: FlaskConical,
    group: "debug",
  },
  {
    id: "debug-reset",
    keywords: t("settings.appData.keywords"),
    title: t("settings.appData.title"),
    description: t("settings.appData.description"),
    icon: Database,
    group: "debug",
  },
];
