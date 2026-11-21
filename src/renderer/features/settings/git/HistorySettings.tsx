import { t } from "@shared/i18n";
import { useEffect, useState } from "react";
import { Checkbox, Select } from "../../../components/ui/index";
import { usePreferencesStore } from "../../../stores/preferences-store";
import { useScopedSetting } from "../hooks/useScopedSetting";

export function HistorySettings() {
  const setting = useScopedSetting("showInternalRefs", "application");
  const mailbox = useScopedSetting("mailboxPreview", "application");
  const density = useScopedSetting("compactHistory", "application");
  const avatars = useScopedSetting("historyAvatars", "application");
  const date = useScopedSetting("historyDateStyle", "application");
  const saving = usePreferencesStore((state) => state.saving);
  const [checked, setChecked] = useState(setting.resolved.value);

  useEffect(() => {
    if (!setting.unavailable) setChecked(setting.resolved.value);
  }, [setting.unavailable, setting.resolved.value]);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{t("historyRefs.commitHistory")}</h2>
      <Checkbox
        checked={mailbox.resolved.value}
        disabled={saving || mailbox.unavailable}
        onChange={(e) => void mailbox.set(e.target.checked)}
      >
        {t("mailbox.preference")}
      </Checkbox>
      <Checkbox
        checked={density.resolved.value}
        disabled={density.unavailable || saving}
        onChange={(e) => void density.set(e.target.checked)}
      >
        {t("historySettings.compact")}
      </Checkbox>
      <Checkbox
        checked={avatars.resolved.value}
        disabled={avatars.unavailable || saving}
        onChange={(e) => void avatars.set(e.target.checked)}
      >
        {t("historySettings.avatars")}
      </Checkbox>
      <label className="flex items-center justify-between gap-2">
        {t("historySettings.date")}
        <Select
          aria-label={t("historySettings.date")}
          value={date.resolved.value}
          disabled={date.unavailable || saving}
          onValueChange={(value) => {
            if (value === "short" || value === "local" || value === "iso") void date.set(value);
          }}
        >
          {(["short", "local", "iso"] as const).map((style) => (
            <option key={style} value={style}>
              {t(`historySettings.${style}`)}
            </option>
          ))}
        </Select>
      </label>
      <Checkbox
        checked={checked}
        disabled={setting.unavailable || saving}
        onChange={(event) => {
          const previous = checked;
          setChecked(event.target.checked);
          void setting.set(event.target.checked).then((saved) => {
            if (!saved) setChecked(previous);
          });
        }}
      >
        {t("historyRefs.showInternalByDefault")}
      </Checkbox>
      <p className="text-xs text-text-secondary">{t("historyRefs.defaultDescription")}</p>
    </section>
  );
}
