import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { useState } from "react";
import { FolderIcon } from "../../components/ui/icons";
import { Button, ErrorDialog, Field, Input } from "../../components/ui/index";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useScopedSetting } from "../settings/hooks/useScopedSetting";

export function RepositoryRootSettings() {
  const root = useScopedSetting("repositoryRoot", "profile");
  const saving = usePreferencesStore((state) => state.saving);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    setChoosing(true);
    setError(null);

    try {
      const result = await window.eda.repository.chooseFolder();

      if (!result.ok) setError(errorMessage(result.error));
      else if (result.value) await root.set(result.value);
    } catch {
      setError(t("cloneRepositoryDialog.folderPickerFailed"));
    } finally {
      setChoosing(false);
    }
  };

  return (
    <div className="space-y-2">
      <Field
        label={t("settings.repositoryRoot.label")}
        hint={t("settings.repositoryRoot.description")}
      >
        {(field) => (
          <fieldset
            disabled={root.unavailable || saving || choosing}
            className="flex min-w-0 gap-2"
          >
            <Input
              {...field}
              readOnly
              aria-busy={root.reading}
              value={root.resolved.value}
              placeholder={t(
                root.reading
                  ? "settings.repositoryRoot.loading"
                  : "cloneRepositoryDialog.chooseParentFolder",
              )}
            />

            <Button icon={<FolderIcon size={15} />} busy={choosing} onClick={() => void choose()}>
              {t("common.browse")}
            </Button>
          </fieldset>
        )}
      </Field>

      <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
    </div>
  );
}
