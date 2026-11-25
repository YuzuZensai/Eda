import { t } from "@shared/i18n";
import { isPullStrategy } from "@shared/workflows/pull";
import { Button, Select } from "../../../components/ui/index";
import { useScopedSetting } from "../hooks/useScopedSetting";
import { preferenceSource, usePreferencesStore } from "../../../stores/preferences-store";

export function RepositoryPullSettings({ repositoryId }: { repositoryId: string }) {
  const strategy = useScopedSetting("pullStrategy", "repository", repositoryId);
  const saving = usePreferencesStore((state) => state.saving);
  const setting = strategy.resolved;

  return (
    <div className="space-y-3">
      <label className="block space-y-2 text-sm">
        {t("settings.repositoryPullSettings.defaultPullStrategy")}
        <Select
          aria-label={t("settings.repositoryPullSettings.defaultPullStrategy")}
          className="w-full"
          disabled={saving || strategy.unavailable}
          value={setting.value}
          onValueChange={(value) => {
            if (isPullStrategy(value)) void strategy.set(value);
          }}
        >
          <option value="ff">
            {t("settings.repositoryPullSettings.fastForwardIfPossibleOtherwiseMerge")}
          </option>
          <option value="ff-only">{t("settings.repositoryPullSettings.fastForwardOnly")}</option>
          <option value="rebase">{t("settings.repositoryPullSettings.rebaseLocalCommits")}</option>
        </Select>
      </label>
      {!strategy.unavailable && (
        <p className="text-xs text-text-tertiary">{preferenceSource(setting)}</p>
      )}
      {setting.source.kind === "repository" && (
        <Button disabled={saving || strategy.unavailable} onClick={() => void strategy.reset()}>
          {t("settings.repositoryPullSettings.resetToDefault")}
        </Button>
      )}
      {setting.value === "rebase" && (
        <p className="text-xs text-text-secondary">
          {t("settings.repositoryPullSettings.rebaseChangesLocalCommitIDs")}
        </p>
      )}
    </div>
  );
}
