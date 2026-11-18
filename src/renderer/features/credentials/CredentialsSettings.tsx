import type { Result } from "@shared/errors";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type {
  AgentStatus,
  ConnectionTestResult,
  SecretMetadata,
  SshKey,
} from "@shared/identity/ssh";
import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Disclosure,
  Field,
  Input,
  NoticeBanner,
  StateMessage,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { SigningSettings } from "./SigningSettings";
import { SshKeyList } from "./SshKeyList";

export function CredentialsSettings() {
  const identity = useAppStore((state) => state.activeIdentity);
  const refreshIdentities = useAppStore((state) => state.refreshIdentities);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [secrets, setSecrets] = useState<SecretMetadata | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const [lifetime, setLifetime] = useState("3600");
  const [host, setHost] = useState("git@github.com");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connection, setConnection] = useState<{
    profileId: string;
    keyPath: string;
    host: string;
    result: Result<ConnectionTestResult>;
  } | null>(null);

  const refresh = async () => {
    const [keyResult, agentResult, secretResult] = await Promise.all([
      window.eda.ssh.listKeys(),
      window.eda.ssh.getAgentStatus(),
      window.eda.credentials.getSecretMetadata(identity?.id),
    ]);

    if (keyResult.ok) setKeys(keyResult.value);
    if (agentResult.ok) setAgent(agentResult.value);

    if (secretResult.ok) {
      setSecrets(secretResult.value);
      setRemember(secretResult.value.remembered);
    }

    const failure = [keyResult, agentResult, secretResult].find((result) => !result.ok);

    if (failure && !failure.ok) setMessage(errorMessage(failure.error));

    return !failure;
  };

  useEffect(() => {
    void refresh();
  }, [identity?.id]);

  useEffect(() => {
    setConnection(null);
  }, [host, identity?.id, identity?.sshKeyPath]);

  if (!identity)
    return (
      <StateMessage
        title={t("credentialsSettings.chooseAProfile")}
        description={t("credentialsSettings.selectAProfileToManageItsCredentialsAndSigningKeys")}
      />
    );

  const selectedKey = keys.find((key) => key.path === identity.sshKeyPath);
  const connectionResult =
    connection?.profileId === identity.id &&
    connection.keyPath === identity.sshKeyPath &&
    connection.host === host.trim()
      ? connection.result
      : null;

  const run = async (name: string, work: () => Promise<string | undefined>) => {
    setBusy(name);
    setMessage(null);

    try {
      const result = await work();
      if (result) setMessage(result);
      await refresh();
    } catch {
      setMessage(t("credentialsSettings.theOperationCouldNotBeCompletedTryAgain"));
    } finally {
      setBusy(null);
    }
  };

  const importKey = () =>
    run("import", async () => {
      const chosen = await window.eda.ssh.choosePrivateKey();

      if (!chosen.ok) return errorMessage(chosen.error);
      if (!chosen.value) return undefined;

      const imported = await window.eda.ssh.importKey(chosen.value);

      if (!imported.ok) return errorMessage(imported.error);

      const assigned = await window.eda.identity.assignSshKey(imported.value.path, identity.id);

      if (!assigned.ok) return errorMessage(assigned.error);

      await refreshIdentities();

      return t("credentialsSettings.importedAndAssigned", {
        fingerprint: imported.value.fingerprint,
      });
    });

  const generateKey = () =>
    run("generate", async () => {
      const chosen = await window.eda.ssh.chooseKeyDestination();

      if (!chosen.ok) return errorMessage(chosen.error);
      if (!chosen.value) return undefined;

      const generated = await window.eda.ssh.generateKey({
        path: chosen.value,
        type: "ed25519",
        comment: identity.gitEmail,
      });

      if (!generated.ok) return errorMessage(generated.error);

      const assigned = await window.eda.identity.assignSshKey(generated.value.path, identity.id);

      if (!assigned.ok) return errorMessage(assigned.error);

      await refreshIdentities();

      return t("credentialsSettings.generatedAndAssigned", {
        fingerprint: generated.value.fingerprint,
      });
    });

  const assign = (path: string | null) =>
    run("assign", async () => {
      const result = await window.eda.identity.assignSshKey(path, identity.id);
      if (!result.ok) return errorMessage(result.error);
      await refreshIdentities();
      return undefined;
    });

  const unlock = () =>
    run("unlock", async () => {
      const seconds = Number(lifetime);
      const result = await window.eda.credentials.unlockActiveKey(
        {
          remember,
          ...(Number.isFinite(seconds) && seconds > 0
            ? { lifetimeSeconds: Math.floor(seconds) }
            : {}),
        },
        passphrase || undefined,
        identity.id,
      );

      if (!result.ok) return errorMessage(result.error);

      setPassphrase("");

      return t("credentialsSettings.keyUnlockedInTheSshAgentTestTheConnectionToCheckServerAccess");
    });

  const forget = () =>
    run("forget", async () => {
      const result = await window.eda.credentials.forgetActivePassphrase(identity.id);
      if (!result.ok) return errorMessage(result.error);
      setRemember(false);
      return t("credentialsSettings.forgotTheSavedPassphrase");
    });

  const testConnection = () =>
    run("test", async () => {
      if (!identity.sshKeyPath) return t("credentialsSettings.assignAnSshKeyFirst");
      setConnection(null);
      const result = await window.eda.ssh.testConnection(host, identity.sshKeyPath);
      setConnection({
        profileId: identity.id,
        keyPath: identity.sshKeyPath,
        host: host.trim(),
        result,
      });
      return undefined;
    });

  return (
    <div className="space-y-6">
      {message && <NoticeBanner>{message}</NoticeBanner>}
      <fieldset disabled={busy !== null} aria-busy={busy !== null} className="min-w-0 space-y-3">
        <legend className="sr-only">{t("credentialsSettings.sshAccess")}</legend>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">{t("credentialsSettings.sshAccess")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              {t("credentialsSettings.chooseAKeyForToConnectToRemoteRepositories", {
                name: identity.name,
              })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={importKey} busy={busy === "import"}>
              {t("credentialsSettings.importKey")}
            </Button>
            <Button size="sm" onClick={generateKey} busy={busy === "generate"}>
              {t("credentialsSettings.generateEd25519")}
            </Button>
          </div>
        </div>

        <SshKeyList
          keys={keys}
          assignedPath={identity.sshKeyPath}
          assigning={busy === "assign"}
          onAssign={assign}
          onRefresh={refresh}
          agentSource={agent?.source}
        />
      </fieldset>

      <SigningSettings
        key={identity.id}
        identity={identity}
        sshKeys={keys}
        onSaved={refreshIdentities}
      />

      {identity.sshKeyPath && (!selectedKey || selectedKey.encrypted) && (
        <fieldset
          disabled={busy !== null}
          aria-busy={busy !== null}
          className="min-w-0 space-y-4 border-t border-border-subtle pt-5"
        >
          <legend className="sr-only">{t("credentialsSettings.unlockSshKey")}</legend>
          <div>
            <h2 className="text-sm font-medium">{t("credentialsSettings.unlockSshKey")}</h2>
            <p className="mt-1 text-xs text-text-secondary">
              {agent?.available
                ? t("credentialsSettings.loadedKeys", {
                    agent:
                      agent.source === "builtin"
                        ? t("credentialsSettings.builtInAgent")
                        : t("credentialsSettings.systemAgent"),
                    count: agent.keys.length,
                  })
                : (agent?.reason ?? t("credentialsSettings.checkingAgent"))}
            </p>
          </div>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field
              label={t("credentialsSettings.passphrase")}
              hint={
                secrets?.remembered
                  ? t("credentialsSettings.leaveBlankToUseTheRememberedPassphrase")
                  : undefined
              }
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
            <Field
              label={t("credentialsSettings.lifetimeSeconds")}
              hint={t("credentialsSettings.emptyMeansAgentDefault")}
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  value={lifetime}
                  onChange={(event) => setLifetime(event.target.value)}
                />
              )}
            </Field>
          </div>
          <div className="space-y-1">
            <Checkbox
              checked={remember}
              disabled={!secrets?.available}
              onChange={(event) => setRemember(event.target.checked)}
            >
              {t("credentialsSettings.rememberFor", { name: identity.name })}
            </Checkbox>
            <p className="pl-8 text-xs text-text-secondary">
              {secrets?.available
                ? t("credentialsSettings.storeThePassphraseInYourOsKeychain")
                : (secrets?.reason ?? t("credentialsSettings.secureStorageUnavailable"))}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={unlock}
              busy={busy === "unlock"}
              disabled={!identity.sshKeyPath || agent?.available === false}
            >
              {t("credentialsSettings.unlockAssignedKey")}
            </Button>
            {secrets?.remembered && (
              <Button size="sm" variant="secondary" onClick={forget} busy={busy === "forget"}>
                {t("credentialsSettings.forgetPassphrase")}
              </Button>
            )}
          </div>
        </fieldset>
      )}

      <Disclosure
        title={t("credentialsSettings.testSshConnection")}
        className="border-t border-border-subtle pt-5"
      >
        <p className="mt-3 text-xs text-text-secondary">
          {t("credentialsSettings.checkTheServerSIdentityAndWhetherIt")}
        </p>
        <fieldset
          disabled={busy !== null}
          aria-busy={busy !== null}
          className="mt-3 grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          <Field
            label={t("credentialsSettings.host")}
            hint={t("credentialsSettings.useHostUserHostOrUserHostPort")}
          >
            {(props) => (
              <Input
                {...props}
                mono
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
            )}
          </Field>
          <Button
            className="sm:mt-6"
            onClick={testConnection}
            busy={busy === "test"}
            disabled={!identity.sshKeyPath}
          >
            {t("credentialsSettings.testConnection")}
          </Button>
        </fieldset>
        {connectionResult && (
          <div className="mt-3 space-y-3">
            <NoticeBanner
              tone={
                !connectionResult.ok
                  ? "error"
                  : connectionResult.value.status === "authenticated"
                    ? "info"
                    : "warning"
              }
            >
              {connectionResult.ok
                ? connectionResult.value.message
                : errorMessage(connectionResult.error)}
            </NoticeBanner>
          </div>
        )}
      </Disclosure>
    </div>
  );
}
