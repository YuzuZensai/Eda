import { errorAction, errorMessage, type GitErrorData } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  PROFILE_NAME_LIMIT,
  GIT_AUTHOR_NAME_LIMIT,
  type Identity,
} from "@shared/identity/identity";
import { builtInSetting } from "@shared/preferences/settings";
import { useState } from "react";
import { ButtonBase } from "../../components/ui/actions/ButtonBase";
import { DialogActions, Dialog, ErrorDialog, Field, Input } from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";

export function IdentityDialog({
  onClose,
  identity,
}: {
  onClose: () => void;
  identity?: Identity;
}) {
  const createIdentity = useAppStore((s) => s.createIdentity);
  const updateIdentity = useAppStore((s) => s.updateIdentity);
  const [error, setError] = useState<string | null>(null);
  const showError = (failure: GitErrorData) =>
    setError([errorMessage(failure), errorAction(failure)].filter(Boolean).join(" "));
  const [name, setName] = useState(identity?.name ?? "");
  const [gitName, setGitName] = useState(identity?.gitName ?? "");
  const [gitEmail, setGitEmail] = useState(identity?.gitEmail ?? "");
  const [saving, setSaving] = useState(false);
  const [touchedEmail, setTouchedEmail] = useState(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gitEmail);
  const validName = name.trim().length <= PROFILE_NAME_LIMIT;
  const validGitName = gitName.trim().length <= GIT_AUTHOR_NAME_LIMIT;
  const canSave =
    name.trim() !== "" && gitName.trim() !== "" && validName && validGitName && emailValid;

  const save = async () => {
    if (!canSave || saving) return;

    setSaving(true);
    setError(null);

    const fields = {
      name: name.trim(),
      gitName: gitName.trim(),
      gitEmail: gitEmail.trim(),
    };

    try {
      const saved = identity
        ? await updateIdentity(identity.id, fields, showError)
        : await createIdentity(
            {
              ...fields,
              hue: builtInSetting("accentHue").value,
              signing: { format: "none", signCommits: false },
            },
            undefined,
            showError,
          );

      if (saved) onClose();
    } catch {
      setError(t("errors.unexpected"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={identity ? t("identityDialog.editProfile") : t("identityDialog.newProfile")}
      description={t("identityDialog.profilesKeepYourGitAuthorCredentialsPreferencesAnd")}
      busy={saving}
      onClose={onClose}
      footer={
        <DialogActions
          onClose={onClose}
          onConfirm={() => void save()}
          confirmLabel={
            saving
              ? t("identityDialog.saving")
              : identity
                ? t("identityDialog.saveProfile")
                : t("identityDialog.createProfile")
          }
          busy={saving}
          confirmDisabled={!canSave}
          confirmVariant="identity"
        />
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          label={t("identityDialog.profileName")}
          error={
            !validName
              ? t("identityDialog.characterLimit", { limit: PROFILE_NAME_LIMIT })
              : undefined
          }
          hint={t("identityDialog.whatYouCallThisContextLikeWorkOrOpenSource")}
        >
          {(props) => (
            <Input
              {...props}
              autoFocus
              invalid={!validName}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("identityDialog.work")}
            />
          )}
        </Field>

        <Field
          label={t("identityDialog.gitName")}
          error={
            !validGitName
              ? t("identityDialog.characterLimit", { limit: GIT_AUTHOR_NAME_LIMIT })
              : undefined
          }
          hint={t("identityDialog.theAuthorNameOnYourCommits")}
        >
          {(props) => (
            <Input
              {...props}
              invalid={!validGitName}
              value={gitName}
              onChange={(e) => setGitName(e.target.value)}
              placeholder={t("identityDialog.eda")}
            />
          )}
        </Field>

        <Field
          label={t("identityDialog.gitEmail")}
          hint={t("identityDialog.theAuthorEmailOnYourCommits")}
          error={
            touchedEmail && gitEmail !== "" && !emailValid
              ? t("identityDialog.enterACompleteEmailAddress")
              : undefined
          }
        >
          {(props) => (
            <Input
              {...props}
              mono
              type="email"
              value={gitEmail}
              onChange={(e) => setGitEmail(e.target.value)}
              onBlur={() => setTouchedEmail(true)}
              invalid={touchedEmail && gitEmail !== "" && !emailValid}
              placeholder={t("identityDialog.edaExampleCom")}
            />
          )}
        </Field>

        {error && <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>}

        <ButtonBase type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
