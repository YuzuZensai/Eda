import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  commitConfigKeys,
  type CommitConfigGroup,
  type GitConfigEntry,
  type ProfileGitInspection,
} from "@shared/identity/profile-session";
import { RotateCcwIcon as RotateCcw, IdentityIcon as UserRound } from "../../components/ui/icons";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AsyncButton,
  DefinitionList,
  Disclosure,
  ErrorDialog,
  RefreshButton,
  StateMessage,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { RepositoryCommitIdentity } from "../settings/repository/RepositoryCommitIdentity";

export function ProfileGitSettings() {
  return <GitSettings scope="profile" />;
}

export function RepositoryGitSettings() {
  const profileId = useAppStore((state) => state.activeIdentity?.id);
  const repositoryId = useAppStore((state) => state.selectedRepositoryId);
  return <GitSettings key={`${profileId}:${repositoryId}`} scope="repository" />;
}

function GitSettings({ scope }: { scope: "profile" | "repository" }) {
  const profile = useAppStore((state) => state.activeIdentity);
  const selectedRepositoryId = useAppStore((state) => state.selectedRepositoryId);
  const repositoryId = scope === "repository" ? selectedRepositoryId : null;
  const repository = useAppStore((state) => state.repositories.find((r) => r.id === repositoryId));
  const [data, setData] = useState<ProfileGitInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"apply" | "clear" | null>(null);
  const headingId = useId();
  const currentHeading = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<boolean> => {
    const request = ++generation.current;

    setError(null);

    if (!profile || (scope === "repository" && !repositoryId)) return false;

    try {
      const result = await window.eda.identity.inspectGit(repositoryId ?? undefined);

      if (request !== generation.current) return false;

      if (result.ok && result.value.profileId === profile.id) {
        setData(result.value);
        return true;
      }

      if (!result.ok) setError(errorMessage(result.error));

      return false;
    } catch {
      if (request === generation.current)
        setError(t("profileGitSettings.couldNotReadGitConfigurationTryRefreshing"));
      return false;
    }
  }, [profile?.id, repositoryId, scope]);

  useEffect(() => {
    setData(null);
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);

  const change = async (
    action: "apply" | "clear",
    group: CommitConfigGroup = "all",
  ): Promise<boolean> => {
    if (!repositoryId || busy) return false;

    const request = generation.current;
    const focused = document.activeElement;

    setFeedback("");
    setBusy(action);

    try {
      const result = await (action === "apply"
        ? window.eda.repository.applyProfile(repositoryId)
        : window.eda.repository.clearLocalCommitConfig(repositoryId, group));

      if (request !== generation.current) return false;

      if (!result.ok) {
        setError(errorMessage(result.error));
        return false;
      }

      const refreshed = await refresh();

      if (refreshed)
        setFeedback(
          action === "apply"
            ? t("profileGitSettings.profileSavedForThisRepository")
            : t("profileGitSettings.localSettingsRemoved", {
                value1: {
                  all: t("profileGitSettings.authorAndSigning"),
                  author: t("profileGitSettings.authorGroup"),
                  signing: t("profileGitSettings.signingGroup"),
                }[group],
              }),
        );

      if (
        refreshed &&
        action === "clear" &&
        focused &&
        (document.activeElement === focused ||
          (document.activeElement === document.body &&
            (!focused.isConnected || (focused instanceof HTMLButtonElement && focused.disabled))))
      )
        currentHeading.current?.focus({ preventScroll: true });

      return refreshed;
    } catch (error) {
      if (request === generation.current) setError(errorMessage(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!profile)
    return (
      <StateMessage
        title={t("profileGitSettings.chooseAProfile")}
        description={t("profileGitSettings.selectAProfileToInspectItsGitConfiguration")}
      />
    );

  if (scope === "repository" && !repositoryId)
    return (
      <StateMessage
        title={t("profileGitSettings.chooseARepository")}
        description={t(
          "profileGitSettings.openAndSelectARepositoryToInspectOrChangeItsLocalGitConfiguration",
        )}
      />
    );

  if (scope === "repository") {
    const entries = data?.repository ?? [];
    const entry = (key: string) => entries.find((item) => item.key === key);
    const source = (key: string) => {
      const value = entry(key);

      if (value?.value === undefined) return t("profileGitSettings.gitDefault");

      if (value.scope === "local")
        return data?.localOverrides?.includes(key)
          ? t("profileGitSettings.thisRepository")
          : t("profileGitSettings.includedGitConfiguration");

      return (
        {
          global: t("profileGitSettings.globalGitConfiguration"),
          worktree: t("profileGitSettings.thisWorktree"),
          system: t("profileGitSettings.systemGitConfiguration"),
          command: t("profileGitSettings.commandConfiguration"),
        }[value.scope ?? ""] ?? t("profileGitSettings.gitConfiguration")
      );
    };

    const hasLocal = (group: CommitConfigGroup) =>
      data?.localOverrides?.some((key) => commitConfigKeys(group).includes(key)) ?? false;
    const signing = entry("commit.gpgsign")?.value;
    const signingEnabled = signing !== undefined && signing !== "false";
    let signingLabel = t("profileGitSettings.off");

    if (signingEnabled) signingLabel = signing === "true" ? t("profileGitSettings.on") : signing;

    const format = entry("gpg.format")?.value;
    let formatLabel = format || "GPG";

    if (format === "ssh") formatLabel = "SSH";
    else if (format === "openpgp") formatLabel = "GPG";

    const key = entry("user.signingkey")?.value;
    const profileSigning =
      profile.signing.format !== "none" && profile.signing.keyRef && profile.signing.signCommits
        ? t("profileGitSettings.signingOn", {
            value1:
              profile.signing.format === "ssh"
                ? t("profileGitSettings.ssh")
                : t("profileGitSettings.gpg"),
          })
        : t("profileGitSettings.signingOff");
    const remove = (group: CommitConfigGroup, label: string) => (
      <AsyncButton
        size="sm"
        variant="ghost"
        label={label}
        icon={<RotateCcw size={14} aria-hidden="true" />}
        disabled={!!busy}
        onAction={() => change("clear", group)}
      >
        {label}
      </AsyncButton>
    );

    return (
      <div className="space-y-6">
        <RepositoryCommitIdentity />

        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>

        <p role="status" className="sr-only">
          {feedback}
        </p>

        <section className="space-y-4" aria-labelledby={`${headingId}-current`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              ref={currentHeading}
              tabIndex={-1}
              id={`${headingId}-current`}
              className="text-sm font-medium"
            >
              {t("profileGitSettings.currentGitSettings")}
            </h2>

            <RefreshButton
              label={t("profileGitSettings.refreshGitSettings")}
              disabled={!!busy}
              onRefresh={refresh}
            />
          </div>

          {!data && !error && (
            <StateMessage tone="loading" title={t("profileGitSettings.readingGitConfiguration")} />
          )}

          {data && (
            <>
              <div className="grid min-w-0 gap-6 lg:grid-cols-2">
                <section className="min-w-0 space-y-3" aria-labelledby={`${headingId}-author`}>
                  <h3 id={`${headingId}-author`} className="text-sm font-medium">
                    {t("profileGitSettings.authorHeading")}
                  </h3>

                  <DefinitionList
                    items={[
                      {
                        label: t("common.name"),
                        value: entry("user.name")?.value || t("profileGitSettings.notConfigured"),
                        description: source("user.name"),
                      },
                      {
                        label: t("common.email"),
                        value: entry("user.email")?.value || t("profileGitSettings.notConfigured"),
                        description: source("user.email"),
                      },
                    ]}
                  />

                  {hasLocal("author") &&
                    remove("author", t("profileGitSettings.removeLocalAuthor"))}
                </section>

                <section className="min-w-0 space-y-3" aria-labelledby={`${headingId}-signing`}>
                  <h3 id={`${headingId}-signing`} className="text-sm font-medium">
                    {t("profileGitSettings.signingHeading")}
                  </h3>

                  <DefinitionList
                    items={[
                      {
                        label: t("profileGitSettings.signCommits"),
                        value: signingLabel,
                        description: source("commit.gpgsign"),
                      },
                      ...(format || key || signingEnabled
                        ? [
                            {
                              label: t("profileGitSettings.format"),
                              value: formatLabel,
                              description: source("gpg.format"),
                            },
                            {
                              label: t("profileGitSettings.key"),
                              value: key || t("profileGitSettings.notConfigured"),
                              description: source("user.signingkey"),
                            },
                          ]
                        : []),
                    ]}
                  />

                  {hasLocal("signing") &&
                    remove("signing", t("profileGitSettings.removeLocalSigning"))}
                </section>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-secondary">
                <p>
                  {hasLocal("all")
                    ? t("profileGitSettings.removingLocalValuesLetsGitUseItsRemainingConfiguration")
                    : t("profileGitSettings.noLocalAuthorOrSigningOverridesInThisRepository")}
                </p>

                {hasLocal("author") &&
                  hasLocal("signing") &&
                  remove("all", t("profileGitSettings.removeBothLocalOverrides"))}
              </div>
            </>
          )}
        </section>

        <section
          className="space-y-3 border-t border-border-subtle pt-5"
          aria-labelledby={`${headingId}-profile`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 id={`${headingId}-profile`} className="text-sm font-medium">
                {t("profileGitSettings.useProfile", { name: profile.name })}
              </h2>

              <p className="break-words text-xs text-text-secondary">
                {profile.gitName}, {profile.gitEmail}, {profileSigning}
              </p>
            </div>

            <AsyncButton
              size="sm"
              label={t("profileGitSettings.useThisProfile")}
              icon={<UserRound size={14} aria-hidden="true" />}
              disabled={!!busy || !data}
              onAction={() => change("apply")}
            >
              {t("profileGitSettings.useThisProfile")}
            </AsyncButton>
          </div>

          <p className="text-xs text-text-tertiary">
            {t("profileGitSettings.saveThisProfileSAuthorAndSigningSettings")}
          </p>
        </section>

        <Disclosure
          title={t("profileGitSettings.advancedGitConfiguration")}
          className="border-t border-border-subtle pt-5"
        >
          <div className="mt-4 space-y-4">
            {repository && (
              <p className="break-all text-xs text-text-tertiary">{repository.path}</p>
            )}

            {data && <ConfigurationEntries entries={entries} />}
          </div>
        </Disclosure>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t("profileGitSettings.commitIdentity")}</h2>

        <DefinitionList
          items={[
            { label: t("profileGitSettings.authorHeading"), value: profile.gitName },
            { label: t("common.email"), value: profile.gitEmail },
          ]}
        />
      </section>

      <section className="space-y-3 border-t border-border-subtle pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{t("profileGitSettings.configurationDetails")}</h2>

          <AsyncButton
            size="sm"
            label={t("profileGitSettings.refreshGitOrigins")}
            disabled={!!busy}
            onAction={refresh}
          >
            {t("profileGitSettings.refreshGitOrigins")}
          </AsyncButton>
        </div>

        <p className="text-xs text-text-secondary">
          {t("profileGitSettings.inspectTheValuesGitReadsAndTheirSourceFiles")}
        </p>

        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>

        {!data && !error && (
          <StateMessage tone="loading" title={t("profileGitSettings.readingGitConfiguration")} />
        )}

        {data && (
          <Disclosure title={t("profileGitSettings.globalGitConfiguration")}>
            <div className="mt-3">
              <ConfigurationEntries entries={data.global} />
            </div>
          </Disclosure>
        )}
      </section>
    </div>
  );
}

function ConfigurationEntries({ entries }: { entries: GitConfigEntry[] }) {
  return (
    <DefinitionList
      items={entries.map((entry) => ({
        label: entry.key,
        value: <span className="font-mono text-xs">{entry.value ?? t("common.notSet")}</span>,
        description: (
          <>
            {entry.scope ? `${entry.scope}, ` : ""}

            {entry.origin ?? t("profileGitSettings.noConfiguredSource")}
          </>
        ),
      }))}
    />
  );
}
