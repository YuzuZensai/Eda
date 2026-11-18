import { t } from "@shared/i18n";
import { useId } from "react";
import { Checkbox, Select } from "../../../components/ui/index";
import { usePreferencesStore } from "../../../stores/preferences-store";
import { useScopedSetting } from "../hooks/useScopedSetting";

export function VigilantModeSettings({
  owner = "application",
}: {
  owner?: "application" | "profile";
}) {
  const setting = useScopedSetting("vigilantMode", owner);
  const saving = usePreferencesStore((state) => state.saving);
  const descriptionId = useId();

  return (
    <section className="space-y-2 border-t border-border-subtle pt-6">
      {owner === "profile" ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-sm font-medium">{t("vigilantModeSettings.title")}</h2>

          <Select
            aria-label={t("vigilantModeSettings.title")}
            aria-describedby={descriptionId}
            disabled={setting.unavailable || saving}
            value={setting.following ? "global" : String(setting.resolved.value)}
            onValueChange={(value) =>
              void (value === "global" ? setting.reset() : setting.set(value === "true"))
            }
          >
            <option value="global">{t("common.followGlobal")}</option>
            <option value="true">{t("settings.appearanceControls.on")}</option>
            <option value="false">{t("settings.appearanceControls.off")}</option>
          </Select>
        </div>
      ) : (
        <Checkbox
          checked={setting.resolved.value}
          disabled={setting.unavailable || saving}
          aria-describedby={descriptionId}
          onChange={(event) => void setting.set(event.target.checked)}
        >
          {t("vigilantModeSettings.title")}
        </Checkbox>
      )}

      <p id={descriptionId} className="text-xs leading-relaxed text-text-secondary">
        {t("vigilantModeSettings.description")}
      </p>
    </section>
  );
}
