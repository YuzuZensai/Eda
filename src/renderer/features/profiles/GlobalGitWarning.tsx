import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { profileGitConfig, type Identity } from "@shared/identity/identity";
import type { GitConfigEntry } from "@shared/identity/profile-session";
import { useEffect, useRef, useState } from "react";
import {
  AsyncButton,
  Button,
  ComparisonTable,
  DefinitionList,
  Dialog,
  Disclosure,
  NoticeBanner,
  StatusBanner,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { simulatedGitConfig } from "../../devtools/git-identity-simulation";
import { resolveGpgSelection } from "@shared/identity/signing";
import { GpgKeyReference } from "../credentials/GpgKeyReference";
import { useGpgKeys } from "../credentials/hooks/useGpgKeys";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useSimulationStore, type GitIdentitySimulation } from "../../stores/simulation-store";

export function GlobalGitWarning({ onReview }: { onReview: () => void }) {
  const profile = useAppStore((state) => state.activeIdentity);
  const switching = useAppStore((state) => state.switchingIdentityId);
  const enabled = usePreferencesStore((state) => state.values.syncGlobalGitConfig.value);
  const owner = usePreferencesStore((state) => state.context.profileId);
  const simulation = useSimulationStore((state) => state.gitIdentity);

  if (!profile || switching) return null;

  const key = JSON.stringify([profile.id, profile.gitName, profile.gitEmail, profile.signing]);

  if (simulation)
    return (
      <SimulatedGlobalGitStatus
        key={`${key}:${simulation}`}
        profile={profile}
        onReview={onReview}
        simulation={simulation}
      />
    );

  if (!enabled || owner !== profile.id) return null;

  return <GlobalGitStatus key={key} profile={profile} onReview={onReview} />;
}

function GlobalGitStatus({ profile, onReview }: { profile: Identity; onReview: () => void }) {
  const [entries, setEntries] = useState<GitConfigEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const reading = useRef(0);
  const applyingRef = useRef(false);
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);

  useEffect(() => {
    mounted.current = true;

    const refresh = async () => {
      const request = ++generation.current;

      reading.current++;

      try {
        const result = await window.eda.identity.inspectGit();

        if (!mounted.current || request !== generation.current) return false;

        if (!result.ok) {
          setError(errorMessage(result.error));

          return false;
        }

        if (result.value.profileId !== profile.id) return false;

        setEntries(result.value.global);
        setError(null);

        const expected = profileGitConfig(profile);
        const matches = result.value.global.every((entry) => entry.value === expected[entry.key]);

        if (matches) setApplyError(null);

        return matches;
      } catch {
        if (mounted.current && request === generation.current)
          setError(t("globalGitWarning.couldNotReadGlobalGitSettingsTryCheckingAgain"));

        return false;
      } finally {
        reading.current--;
      }
    };

    refreshRef.current = refresh;

    const check = () => {
      if (document.visibilityState !== "hidden" && !reading.current && !applyingRef.current)
        void refresh();
    };

    void refresh();

    const timer = window.setInterval(check, 5_000);

    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);

    return () => {
      mounted.current = false;
      generation.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [profile]);

  const apply = async () => {
    if (!mounted.current || applyingRef.current || useSimulationStore.getState().gitIdentity)
      return false;

    applyingRef.current = true;
    setApplying(true);
    setApplyError(null);
    generation.current++;

    try {
      const result = await window.eda.identity.reapplyGlobal(profile.id);

      if (!mounted.current) return false;

      if (!result.ok) {
        setApplyError(errorMessage(result.error));

        return false;
      }

      const matches = await refreshRef.current();

      if (mounted.current && !matches)
        setApplyError(
          t("globalGitWarning.globalGitSettingsStillDifferReviewTheirSourceFilesAndTryAgain"),
        );

      return matches;
    } catch {
      if (mounted.current)
        setApplyError(t("globalGitWarning.couldNotApplyGlobalGitSettingsTryAgain"));

      return false;
    } finally {
      applyingRef.current = false;

      if (mounted.current) setApplying(false);
    }
  };

  return (
    <GlobalGitStatusView
      profile={profile}
      onReview={onReview}
      entries={entries}
      error={error}
      applyError={applyError}
      applying={applying}
      apply={apply}
      refresh={() => refreshRef.current()}
    />
  );
}

function SimulatedGlobalGitStatus({
  profile,
  onReview,
  simulation,
}: {
  profile: Identity;
  onReview: () => void;
  simulation: GitIdentitySimulation;
}) {
  const [applyError, setApplyError] = useState<string | null>(null);
  const apply = async () => {
    if (useSimulationStore.getState().gitIdentity !== simulation) return false;

    if (simulation === "apply-error") {
      setApplyError(t("settings.stateSimulations.gitRepairError"));

      return false;
    }

    useSimulationStore.getState().setGitIdentity("matched");

    return true;
  };

  return (
    <GlobalGitStatusView
      profile={profile}
      onReview={onReview}
      entries={simulatedGitConfig(profile, simulation === "matched")}
      error={null}
      applyError={applyError}
      applying={false}
      apply={apply}
      refresh={async () => {
        setApplyError(null);

        return simulation === "matched";
      }}
      simulated
    />
  );
}

function GlobalGitStatusView({
  profile,
  onReview,
  entries,
  error,
  applyError,
  applying,
  apply,
  refresh,
  simulated = false,
}: {
  profile: Identity;
  onReview: () => void;
  entries: GitConfigEntry[] | null;
  error: string | null;
  applyError: string | null;
  applying: boolean;
  apply: () => Promise<boolean>;
  refresh: () => Promise<boolean>;
  simulated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expected = profileGitConfig(profile);
  const differences = entries?.filter((entry) => entry.value !== expected[entry.key]) ?? [];
  const gpgComparison =
    profile.signing.format === "gpg" &&
    (entries?.find((entry) => entry.key === "gpg.format")?.value ?? "openpgp") === "openpgp" &&
    differences.some((entry) => entry.key === "user.signingkey");
  const gpg = useGpgKeys(profile.id, open && !simulated && gpgComparison);
  const currentKey = entries?.find((entry) => entry.key === "user.signingkey")?.value ?? "";
  const currentSelection = resolveGpgSelection(currentKey, gpg.keys);
  const profileSelection = resolveGpgSelection(profile.signing.keyRef ?? "", gpg.keys);
  const sameGpgIdentity =
    gpgComparison &&
    currentSelection &&
    profileSelection &&
    currentSelection.identity.fingerprint === profileSelection.identity.fingerprint;
  const displayValue = (key: string, value: string | undefined) =>
    key === "user.signingkey" && gpgComparison && value ? (
      <GpgKeyReference value={value} keys={gpg.keys} />
    ) : (
      settingValue(key, value)
    );

  if (!differences.length && !error && !applyError) return null;

  return (
    <>
      <StatusBanner
        label={t("globalGitWarning.globalGitConfigurationWarning")}
        tone="warning"
        action={
          <Button
            size="sm"
            variant="quiet"
            aria-label={t("globalGitWarning.reviewGlobalGitSettings")}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            {t("globalGitWarning.review")}
          </Button>
        }
      >
        {applyError
          ? t("globalGitWarning.couldNotUpdateGlobalGitSettings")
          : error
            ? t("globalGitWarning.couldNotCheckGlobalGitSettings")
            : t("globalGitWarning.globalGitSettingsDifferFrom", { name: profile.name })}
      </StatusBanner>

      {open && (
        <Dialog
          size="lg"
          title={t("globalGitWarning.reviewGlobalGitSettings")}
          description={
            simulated
              ? t("settings.stateSimulations.gitPreviewActive")
              : t("globalGitWarning.globalGitSyncIsEnabledForReviewThe", {
                  name: profile.name,
                })
          }
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button
                variant="ghost"
                className="mr-auto"
                onClick={() => {
                  setOpen(false);
                  onReview();
                }}
              >
                {t("globalGitWarning.globalGitSettings")}
              </Button>

              <Button variant="secondary" onClick={() => setOpen(false)}>
                {t("common.close")}
              </Button>

              <AsyncButton
                label={t("globalGitWarning.applyProfileGlobally")}
                variant="primary"
                disabled={applying}
                onAction={apply}
              >
                {t("globalGitWarning.applyProfileGlobally")}
              </AsyncButton>
            </>
          }
        >
          <div className="space-y-5">
            {(error || applyError) && (
              <NoticeBanner
                tone="error"
                action={
                  <AsyncButton
                    size="sm"
                    label={t("globalGitWarning.checkGlobalGitSettings")}
                    variant="ghost"
                    disabled={applying}
                    onAction={refresh}
                  >
                    {t("globalGitWarning.checkAgain")}
                  </AsyncButton>
                }
              >
                {applyError || error}
              </NoticeBanner>
            )}

            {!!differences.length && (
              <section aria-label={t("globalGitWarning.changesToApply")} className="space-y-3">
                <h3 className="text-sm font-medium">{t("globalGitWarning.changesToApply")}</h3>

                <ComparisonTable
                  label={t("globalGitWarning.changesToApply")}
                  fieldLabel={t("globalGitWarning.setting")}
                  beforeLabel={t("globalGitWarning.currentGit")}
                  afterLabel={t("globalGitWarning.profile", { name: profile.name })}
                  rows={differences.map((entry) => ({
                    id: entry.key,
                    label: settingLabel(entry.key),
                    before: displayValue(entry.key, entry.value),
                    after: displayValue(entry.key, expected[entry.key]),
                  }))}
                />
                {sameGpgIdentity && (
                  <p className="text-xs leading-relaxed text-text-secondary">
                    {t("globalGitWarning.sameGpgIdentity")}
                  </p>
                )}
              </section>
            )}

            <NoticeBanner>
              {simulated
                ? t("settings.stateSimulations.gitPreviewActive")
                : t("globalGitWarning.applyingThisProfileUpdatesGlobalGitSettingsUsed")}
            </NoticeBanner>

            {!!differences.length && (
              <Disclosure title={t("globalGitWarning.configurationSources")}>
                <div className="mt-3">
                  <DefinitionList
                    items={differences.map((entry) => ({
                      label: entry.key,
                      value: entry.origin ?? t("globalGitWarning.noGlobalValue"),
                    }))}
                  />
                </div>
              </Disclosure>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

function settingLabel(key: string): string {
  return (
    {
      "user.name": t("globalGitWarning.authorName"),
      "user.email": t("common.email"),
      "gpg.format": t("globalGitWarning.signingFormat"),
      "user.signingkey": t("globalGitWarning.signingKey"),
      "commit.gpgsign": t("globalGitWarning.signCommits"),
    }[key] ?? key
  );
}

function settingValue(key: string, value: string | undefined): string {
  if (value === undefined) return t("globalGitWarning.notConfigured");

  if (key === "commit.gpgsign") {
    if (value === "true") return t("globalGitWarning.on");

    if (value === "false") return t("globalGitWarning.off");
  }

  if (key === "gpg.format")
    return value === "ssh"
      ? t("globalGitWarning.ssh")
      : value === "openpgp"
        ? t("globalGitWarning.gpg")
        : value;

  return value;
}
