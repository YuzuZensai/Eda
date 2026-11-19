import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { RepositorySummary } from "@shared/repository/repository";
import { useState } from "react";
import {
  DialogActions,
  ActionList,
  Button,
  Checkbox,
  Dialog,
  ErrorDialog,
  Select,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { useSessionStore } from "../../stores/session-store";
import { RemoveRepositoryButton } from "../repositories/RemoveRepositoryButton";
import { RepositoryRootSettings } from "./RepositoryRootSettings";

export function ProfileRepositoriesSettings() {
  const active = useAppStore((state) => state.activeIdentity);
  const profiles = useAppStore((state) => state.identities);
  const repositories = useAppStore((state) => state.repositories);
  const hasOtherProfiles = profiles.some((profile) => profile.id !== active?.id);

  return (
    <div className="flex flex-col gap-5 text-sm">
      <RepositoryRootSettings />

      <div className="flex items-center justify-between gap-3">
        <p className="text-text-secondary">
          {t("profileRepositoriesSettings.repositoryListFor", {
            value1: active?.name ?? t("profileRepositoriesSettings.thisProfile"),
          })}
        </p>

        <Button size="sm" onClick={() => void useAppStore.getState().addRepository()}>
          {t("profileRepositoriesSettings.addFromDisk")}
        </Button>
      </div>

      {repositories.length > 0 ? (
        <ActionList
          items={repositories.map((repository) => ({
            id: repository.id,
            title: (
              <>
                {repository.name}

                <span className="ml-2 text-xs font-normal text-text-tertiary">
                  {repository.available
                    ? t("profileRepositoriesSettings.available")
                    : t("profileRepositoriesSettings.missingFolder")}
                </span>
              </>
            ),
            description: (
              <span className="mono break-all text-xs text-text-tertiary">{repository.path}</span>
            ),
            actions: (
              <>
                {hasOtherProfiles && <RepositoryProfileAction repository={repository} />}
                <RemoveRepositoryButton repository={repository} />
              </>
            ),
          }))}
        />
      ) : (
        <p className="text-text-tertiary">
          {t("profileRepositoriesSettings.noRepositoriesSavedAddARepositoryFolderToGetStarted")}
        </p>
      )}
    </div>
  );
}

function RepositoryProfileAction({ repository }: { repository: RepositorySummary }) {
  const profiles = useAppStore((state) => state.identities);
  const active = useAppStore((state) => state.activeIdentity);
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState("");
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = profiles.filter((profile) => profile.id !== active?.id);

  const targetId = candidates.some((profile) => profile.id === target)
    ? target
    : (candidates[0]?.id ?? "");

  const save = async () => {
    if (!targetId) return;

    setBusy(true);
    setError(null);

    try {
      if (!(await useSessionStore.getState().flush())) {
        setError(
          useSessionStore.getState().error ??
            t("profileRepositoriesSettings.couldNotSaveTheCurrentSessionTryAgain"),
        );

        return;
      }

      if (useAppStore.getState().activeIdentity?.id !== sourceId) {
        setError(
          t("profileRepositoriesSettings.theActiveProfileChangedCloseThisDialogAndTryAgain"),
        );

        return;
      }

      const result = await window.eda.repository.assignProfile(repository.id, targetId, move);

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      await useAppStore.getState().refreshRepositories();
      setOpen(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="quiet"
        onClick={() => {
          setSourceId(active?.id);
          setMove(false);
          setError(null);
          setOpen(true);
        }}
      >
        {t("profileRepositoriesSettings.addToAnotherProfile")}
      </Button>

      {open && (
        <Dialog
          title={t("profileRepositoriesSettings.addRepositoryToProfile", { name: repository.name })}
          busy={busy}
          onClose={() => setOpen(false)}
          footer={
            <DialogActions
              onClose={() => setOpen(false)}
              onConfirm={() => void save()}
              confirmLabel={
                move
                  ? t("profileRepositoriesSettings.moveToProfile")
                  : t("profileRepositoriesSettings.addToProfile")
              }
              busy={busy}
              confirmDisabled={!targetId}
              confirmVariant="secondary"
            />
          }
        >
          <div className="flex flex-col gap-4 text-sm">
            <p className="mono break-all text-xs text-text-tertiary">{repository.path}</p>

            <label className="flex items-center gap-2">
              {t("profileRepositoriesSettings.addToProfile")}

              <Select
                aria-label={t("profileRepositoriesSettings.destinationProfile")}
                value={targetId}
                onValueChange={setTarget}
                surface="surface"
                compact
                disabled={busy}
              >
                {candidates.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </Select>
            </label>

            <p>{t("profileRepositoriesSettings.bothProfilesWillUseTheSameFilesAnd")}</p>

            <Checkbox
              checked={move}
              disabled={busy}
              onChange={(event) => setMove(event.target.checked)}
            >
              {t("profileRepositoriesSettings.alsoRemoveFrom", {
                value1: active?.name ?? t("profileRepositoriesSettings.thisProfile"),
              })}
            </Checkbox>

            <p className="text-xs text-text-secondary">
              {move
                ? t("profileRepositoriesSettings.thisDeletesTheSourceProfileSSavedDrafts")
                : t(
                    "profileRepositoriesSettings.theRepositoryStaysInThisProfileSListTooFilesStayInTheSameFolder",
                  )}
            </p>
          </div>

          <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
        </Dialog>
      )}
    </>
  );
}
