import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import { useState } from "react";
import {
  DialogActions,
  Checkbox,
  Dialog,
  ErrorDialog,
  Field,
  Input,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { useSessionStore } from "../../stores/session-store";

export function DuplicateProfile({ profile, onClose }: { profile: Identity; onClose: () => void }) {
  const [name, setName] = useState(t("profiles.duplicateProfile.copy", { name: profile.name }));
  const [preferences, setPreferences] = useState(true);
  const [repositories, setRepositories] = useState(true);
  const [tabs, setTabs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);

    try {
      if (!(await useSessionStore.getState().flush())) return;

      const result = await window.eda.identity.duplicate(profile.id, {
        name,
        preferences,
        repositories,
        tabs: repositories && tabs,
      });

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      await useAppStore.getState().refreshIdentities();
      onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("profiles.duplicateProfile.duplicateProfile")}
      description={t("profiles.duplicateProfile.createANewProfileFromTheCopyStaysInactive", {
        name: profile.name,
      })}
      busy={busy}
      onClose={onClose}
      footer={
        <DialogActions
          onClose={onClose}
          onConfirm={() => void save()}
          confirmLabel={t("profiles.duplicateProfile.createCopy")}
          busy={busy}
          confirmDisabled={!name.trim()}
        />
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <Field label={t("profiles.duplicateProfile.profileName")}>
          {(props) => (
            <Input
              {...props}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>

        <Checkbox checked={preferences} onChange={(event) => setPreferences(event.target.checked)}>
          {t("profiles.duplicateProfile.copyPreferenceOverrides")}
        </Checkbox>

        <Checkbox
          checked={repositories}
          onChange={(event) => setRepositories(event.target.checked)}
        >
          {t("profiles.duplicateProfile.copyRepositoryMemberships")}
        </Checkbox>

        <Checkbox
          checked={tabs}
          disabled={!repositories}
          onChange={(event) => setTabs(event.target.checked)}
        >
          {t("profiles.duplicateProfile.copyTabsAndLayout")}
        </Checkbox>

        <p className="text-xs text-text-tertiary">
          {t("profiles.duplicateProfile.authorDetailsAreCopiedKeys")}
        </p>
        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
