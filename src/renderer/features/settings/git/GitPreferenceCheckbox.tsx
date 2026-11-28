import { useEffect, useState } from "react";
import { Checkbox } from "../../../components/ui/index";
import { usePreferencesStore } from "../../../stores/preferences-store";
import { useScopedSetting } from "../hooks/useScopedSetting";

export function GitPreferenceCheckbox({
  settingKey,
  className,
  repositoryId,
  label,
}: {
  settingKey: "fetchPrune" | "fetchTags" | "predictUpstreamConflicts" | "showInternalRefs";
  className?: string;
  repositoryId?: string;
  label: string;
}) {
  const setting = useScopedSetting(
    settingKey,
    repositoryId ? "repository" : "application",
    repositoryId,
  );
  const saving = usePreferencesStore((state) => state.saving);
  const [checked, setChecked] = useState(setting.resolved.value);
  useEffect(() => {
    if (!setting.unavailable) setChecked(setting.resolved.value);
  }, [setting.unavailable, setting.resolved.value]);
  return (
    <Checkbox
      className={className}
      checked={checked}
      disabled={saving || setting.unavailable}
      onChange={(event) => {
        const previous = checked;
        setChecked(event.target.checked);
        void setting.set(event.target.checked).then((saved) => {
          if (!saved) setChecked(previous);
        });
      }}
    >
      {label}
    </Checkbox>
  );
}
