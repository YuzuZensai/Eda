import { t } from "@shared/i18n";
import { useState } from "react";
import { useScopedSetting } from "../hooks/useScopedSetting";
import { Select } from "../../../components/ui/index";
import { usePreferencesStore } from "../../../stores/preferences-store";
import { GitPreferenceCheckbox } from "./GitPreferenceCheckbox";

export function FetchSettings({ repositoryId }: { repositoryId?: string }) {
  const override = useScopedSetting("backgroundFetchMinutes", "repository", repositoryId);
  const inherited = useScopedSetting("backgroundFetchMinutes", "application");
  const interval = repositoryId ? override : inherited;
  const saving = usePreferencesStore((state) => state.saving);
  const [busy, setBusy] = useState(false);
  const label = (minutes: number) =>
    minutes
      ? t("settings.fetchSettings.everyMinutes", { minutes: minutes })
      : t("settings.fetchSettings.off");
  return (
    <div className="space-y-5">
      <h2 className="text-sm font-medium">{t("settings.fetchSettings.backgroundFetch")}</h2>
      <p className="text-xs text-text-secondary">
        {t("settings.fetchSettings.fetchOpenRepositoriesInTheActiveProfileWhileEdaIsRunning")}
      </p>
      <label className="block space-y-2 text-sm">
        {t("settings.fetchSettings.backgroundFetchInterval")}
        <Select
          aria-label={t("settings.fetchSettings.backgroundFetchInterval")}
          className="w-full"
          disabled={saving || busy || interval.unavailable || inherited.unavailable}
          value={repositoryId && interval.following ? "inherit" : String(interval.resolved.value)}
          onValueChange={(value) => {
            setBusy(true);
            void (value === "inherit" ? interval.reset() : interval.set(Number(value))).finally(
              () => setBusy(false),
            );
          }}
        >
          {repositoryId && (
            <option value="inherit">
              {t("settings.fetchSettings.useGlobalDefault", {
                value1: label(inherited.resolved.value),
              })}
            </option>
          )}
          {[...new Set([0, 1, 5, 10, 15, 30, 60, interval.resolved.value])]
            .sort((a, b) => a - b)
            .map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {label(minutes)}
              </option>
            ))}
        </Select>
      </label>
      {repositoryId && (
        <div className="space-y-3 border-t border-border-subtle pt-4">
          <h2 className="text-sm font-medium">{t("settings.fetchSettings.fetchDefaults")}</h2>
          <GitPreferenceCheckbox
            settingKey="fetchPrune"
            className="flex w-full"
            repositoryId={repositoryId}
            label={t("settings.fetchSettings.pruneDeletedRemoteTrackingBranches")}
          />
          <GitPreferenceCheckbox
            settingKey="predictUpstreamConflicts"
            className="flex w-full"
            repositoryId={repositoryId}
            label={t("mergePrediction.preference")}
          />
          <GitPreferenceCheckbox
            settingKey="fetchTags"
            className="flex w-full"
            repositoryId={repositoryId}
            label={t("settings.fetchSettings.fetchAllTags")}
          />
          <p className="text-xs text-text-tertiary">
            {t("settings.fetchSettings.tagFetchDescription")}
          </p>
          <p className="text-xs text-text-tertiary">
            {t(
              "settings.fetchSettings.pruningRemovesStaleTrackingReferencesLocalBranchesArePreserved",
            )}
          </p>
        </div>
      )}
    </div>
  );
}
