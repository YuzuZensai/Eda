import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type {
  GitLabSelfHostedStatus,
  GitLabTokenForm,
} from "@shared/integrations/gitlab-self-hosted";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/index";
import { GitLabSelfHostedAccountCard } from "./GitLabSelfHostedAccountCard";
import { GitLabSelfHostedSetup } from "./GitLabSelfHostedSetup";
import { ServiceAccountCard } from "./ServiceAccountCard";
import { GitLabSelfHostedAccountActions } from "./GitLabSelfHostedAccountActions";
import { ConnectionActionSkeleton } from "./ConnectionSkeleton";

export function GitLabSelfHostedConnection({
  profileId,
  compact = false,
}: {
  profileId: string;
  compact?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<GitLabSelfHostedStatus | null>(null);
  const [setupBaseUrl, setSetupBaseUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const saving = useRef(false);
  const singleAccount = status?.accounts.length === 1 ? status.accounts[0] : undefined;

  const load = async () => {
    setLoading(true);

    try {
      const result = await window.eda.gitlabSelfHosted.status(profileId);
      if (!alive.current) return;

      if (result.ok) setStatus(result.value);
      else setError(errorMessage(result.error));
    } catch {
      if (alive.current) setError(t("settings.gitLabSelfHosted.loadFailed"));
    } finally {
      if (alive.current) setLoading(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    void load();

    return () => {
      alive.current = false;
      if (saving.current) void window.eda.gitlabSelfHosted.cancel(profileId);
    };
  }, [profileId]);

  const action = async (work: () => Promise<void | boolean>): Promise<boolean> => {
    if (busy) return false;

    setBusy(true);
    setError(null);

    try {
      return (await work()) !== false;
    } catch {
      if (alive.current) setError(t("settings.gitLabSelfHosted.actionFailed"));

      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const connect = async (baseUrl: string, token: string, ignoreTlsErrors: boolean) => {
    if (busy) return;

    saving.current = true;
    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.gitlabSelfHosted.connect(
        profileId,
        baseUrl,
        token,
        ignoreTlsErrors,
      );

      if (!alive.current || !saving.current) return;

      if (result.ok) {
        setStatus(result.value);
        setSetupBaseUrl(null);
      } else setError(errorMessage(result.error));
    } catch {
      if (alive.current && saving.current) setError(t("settings.gitLabSelfHosted.actionFailed"));
    } finally {
      saving.current = false;

      if (alive.current) setBusy(false);
    }
  };

  const openSetup = (baseUrl = "") => {
    setError(null);
    setSetupBaseUrl(baseUrl);
  };

  const closeSetup = () => {
    if (saving.current) {
      saving.current = false;
      void window.eda.gitlabSelfHosted.cancel(profileId);
    }

    setSetupBaseUrl(null);
    setError(null);
  };

  const openProfile = (instanceUrl: string, copyUrl = false) =>
    action(async () => {
      const result = await (copyUrl
        ? window.eda.gitlabSelfHosted.openProfile(profileId, instanceUrl, true)
        : window.eda.gitlabSelfHosted.openProfile(profileId, instanceUrl));

      if (alive.current && !result.ok) setError(errorMessage(result.error));
      return result.ok;
    });

  const openTokenSettings = (instanceUrl: string, form: GitLabTokenForm, copyUrl = false) =>
    action(async () => {
      const result = await (copyUrl
        ? window.eda.gitlabSelfHosted.openTokenSettings(profileId, instanceUrl, form, true)
        : window.eda.gitlabSelfHosted.openTokenSettings(profileId, instanceUrl, form));

      if (alive.current && !result.ok) setError(errorMessage(result.error));

      return result.ok;
    });

  const disconnect = (instanceUrl: string) =>
    action(async () => {
      const result = await window.eda.gitlabSelfHosted.disconnect(profileId, instanceUrl);

      if (!alive.current) return;

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      setStatus(
        (current) =>
          current && {
            ...current,
            accounts: current.accounts.filter((account) => account.baseUrl !== instanceUrl),
          },
      );
    });

  return (
    <ServiceAccountCard
      provider="GitLab Self-Hosted"
      compact={compact}
      pendingLabel={
        busy || (loading && compact) ? t("settings.gitLabSelfHosted.setupTitle") : undefined
      }
      bodyOpen={(status?.accounts.length ?? 0) > 1 || setupBaseUrl !== null || !!error}
      summary={
        singleAccount ? (
          <GitLabSelfHostedAccountCard
            profileId={profileId}
            account={singleAccount}
            busy={busy}
            secureStorage={status?.secureStorage ?? false}
            showActions={false}
            onOpen={openProfile}
            onEdit={openSetup}
            onDisconnect={(value) => void disconnect(value)}
          />
        ) : status?.accounts.length ? (
          t("settings.connections.instances", { count: status.accounts.length })
        ) : null
      }
      actions={
        <>
          {loading && <ConnectionActionSkeleton label={t("settings.gitLabSelfHosted.connect")} />}

          {status && setupBaseUrl === null && (
            <Button size="sm" disabled={busy} onClick={() => openSetup()}>
              {t(
                status.accounts.length
                  ? "settings.gitLabSelfHosted.addInstance"
                  : "settings.gitLabSelfHosted.connect",
              )}
            </Button>
          )}

          {singleAccount && !compact && setupBaseUrl === null && (
            <GitLabSelfHostedAccountActions
              account={singleAccount}
              disabled={busy || !status?.secureStorage}
              onEdit={openSetup}
              onDisconnect={(value) => void disconnect(value)}
            />
          )}
        </>
      }
    >
      {!status ? (
        error && (
          <div className="space-y-2">
            <Button size="sm" disabled={busy} onClick={() => void action(load)}>
              {t("settings.gitLabSelfHosted.retry")}
            </Button>

            <p role="alert" className="text-xs text-git-deleted">
              {error}
            </p>
          </div>
        )
      ) : (
        <>
          {(status.accounts.length > 1 || (compact && status.accounts.length > 0)) && (
            <div className="divide-y divide-border-subtle">
              {status.accounts.map((account) => (
                <GitLabSelfHostedAccountCard
                  key={account.baseUrl}
                  profileId={profileId}
                  account={account}
                  busy={busy}
                  secureStorage={status.secureStorage}
                  onOpen={openProfile}
                  onEdit={openSetup}
                  onDisconnect={(value) => void disconnect(value)}
                />
              ))}
            </div>
          )}

          {setupBaseUrl !== null ? (
            <GitLabSelfHostedSetup
              key={setupBaseUrl}
              initialBaseUrl={setupBaseUrl}
              initialIgnoreTlsErrors={
                status.accounts.find((account) => account.baseUrl === setupBaseUrl)
                  ?.ignoreTlsErrors ?? false
              }
              secureStorage={status.secureStorage}
              busy={busy}
              error={error}
              onConnect={connect}
              onOpenTokenSettings={openTokenSettings}
              onClose={closeSetup}
              onClearError={() => setError(null)}
            />
          ) : (
            error && (
              <p role="alert" className="text-xs text-git-deleted">
                {error}
              </p>
            )
          )}
        </>
      )}
    </ServiceAccountCard>
  );
}
