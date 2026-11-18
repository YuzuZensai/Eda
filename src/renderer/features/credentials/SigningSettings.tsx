import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity, SigningFormat } from "@shared/identity/identity";
import type { SshKey } from "@shared/identity/ssh";
import { useState } from "react";
import { Button, Checkbox, ErrorDialog, Field, Select } from "../../components/ui/index";
import { GpgKeyPicker } from "./GpgKeyPicker";
import { useGpgKeys } from "./hooks/useGpgKeys";

export function SigningSettings({
  identity,
  sshKeys,
  onSaved,
}: {
  identity: Identity;
  sshKeys: SshKey[];
  onSaved: () => Promise<void>;
}) {
  const [format, setFormat] = useState<SigningFormat>(identity.signing.format);
  const [keyRefs, setKeyRefs] = useState({
    gpg: identity.signing.format === "gpg" ? (identity.signing.keyRef ?? "") : "",
    ssh:
      identity.signing.format === "ssh"
        ? (identity.signing.keyRef ?? "")
        : identity.sshKeyPath
          ? `${identity.sshKeyPath}.pub`
          : "",
  });

  const [signCommits, setSignCommits] = useState(identity.signing.signCommits);
  const gpg = useGpgKeys(identity.id, format === "gpg");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyRef = format === "none" ? "" : keyRefs[format];
  const sshOptions = sshKeys.map((key) => ({
    value: key.publicKeyPath,
    label: `${key.comment || key.publicKeyPath}, ${key.type}, ${key.fingerprint}`,
  }));
  const assignedPublicKey = identity.sshKeyPath ? `${identity.sshKeyPath}.pub` : null;

  if (assignedPublicKey && !sshOptions.some((key) => key.value === assignedPublicKey))
    sshOptions.unshift({
      value: assignedPublicKey,
      label: t("signingSettings.assignedSshKey", { assignedPublicKey: assignedPublicKey }),
    });

  const save = async (nextFormat = format, nextKey = keyRef, nextSignCommits = signCommits) => {
    if (saving || (nextFormat !== "none" && !nextKey.trim())) return;

    setSaving(true);
    setError(null);

    try {
      const result = await window.eda.identity.configureSigning(
        {
          format: nextFormat,
          ...(nextFormat !== "none" && nextKey.trim() ? { keyRef: nextKey.trim() } : {}),
          signCommits: nextFormat !== "none" && nextSignCommits,
        },
        identity.id,
      );

      if (!result.ok) setError(errorMessage(result.error));
      else {
        await onSaved();
      }
    } catch {
      setError(t("signingSettings.couldNotSaveSigningConfigurationYourSelectionHasBeenRetained"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset
      disabled={saving}
      aria-busy={saving}
      className="grid min-w-0 gap-3 border-t border-border-subtle pt-5"
    >
      <legend className="sr-only">{t("signingSettings.commitSigning")}</legend>
      <h2 className="text-sm font-medium">{t("signingSettings.commitSigning")}</h2>
      <p className="text-xs leading-relaxed text-text-secondary">
        {t("signingSettings.signCommitsToVerifyTheyWereCreatedByThisProfile")}
      </p>
      <Field label={t("signingSettings.format")}>
        {(props) => (
          <Select
            {...props}
            className="w-full"
            value={format}
            onValueChange={(value) => {
              const next = value as SigningFormat;
              setFormat(next);
              setError(null);
              void save(next, next === "none" ? "" : keyRefs[next]);
            }}
          >
            <option value="none">{t("signingSettings.disabled")}</option>
            <option value="ssh">{t("signingSettings.ssh")}</option>
            <option value="gpg">{t("signingSettings.gpg")}</option>
          </Select>
        )}
      </Field>
      {format === "gpg" && (
        <GpgKeyPicker
          value={keyRefs.gpg}
          keys={gpg.keys}
          email={identity.gitEmail}
          loading={gpg.loading}
          error={gpg.error}
          onChange={(value) => setKeyRefs({ ...keyRefs, gpg: value })}
          onRefresh={gpg.refresh}
          onCommit={(value) => void save("gpg", value)}
        />
      )}
      {format === "ssh" && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field
            label={t("signingSettings.sshSigningKey")}
            hint={t("signingSettings.selectADetectedKeyOrChooseAnotherPublicPubFile")}
          >
            {(props) => (
              <Select
                {...props}
                className="min-w-0 w-full"
                value={keyRefs.ssh}
                onValueChange={(value) => {
                  setKeyRefs({ ...keyRefs, ssh: value });
                  void save("ssh", value);
                }}
              >
                <option value="" disabled>
                  {t("signingSettings.chooseSigningKey")}
                </option>
                {keyRefs.ssh && !sshOptions.some((key) => key.value === keyRefs.ssh) && (
                  <option value={keyRefs.ssh}>{keyRefs.ssh}</option>
                )}
                {sshOptions.map((key) => (
                  <option key={key.value} value={key.value}>
                    {key.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button
            onClick={() => {
              setError(null);
              void window.eda.ssh
                .choosePublicKey()
                .then((result) => {
                  if (!result.ok) setError(errorMessage(result.error));
                  else if (result.value) {
                    setKeyRefs((current) => ({ ...current, ssh: result.value! }));
                    void save("ssh", result.value);
                  }
                })
                .catch(() => setError(t("signingSettings.couldNotChooseAnSshPublicKey")));
            }}
          >
            {t("signingSettings.choosePublicKey")}
          </Button>
        </div>
      )}

      <Checkbox
        className="flex items-center gap-2 text-sm"
        checked={signCommits}
        disabled={format === "none" || !keyRef.trim()}
        onChange={(event) => {
          setSignCommits(event.target.checked);
          void save(format, keyRef, event.target.checked);
        }}
      >
        {t("signingSettings.signCommitsByDefault")}
      </Checkbox>
      <ErrorDialog
        actions={
          <Button size="sm" onClick={() => void save()}>
            {t("signingSettings.retrySaving")}
          </Button>
        }
        onDismiss={() => setError(null)}
      >
        {error}
      </ErrorDialog>
    </fieldset>
  );
}
