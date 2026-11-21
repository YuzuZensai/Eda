import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { GitLabSignIn, GitLabStatus, GitLabAccountProfile } from "@shared/integrations/gitlab";
import { useEffect, useState } from "react";
import { UnplugIcon as Unplug } from "../../components/ui/icons";
import { ExternalLinkButton, Button, ActionsMenu } from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { AccountActions, ServiceAccountCard } from "./ServiceAccountCard";
import { ConnectionProfile } from "./ConnectionProfile";
import { ConnectionActionSkeleton } from "./ConnectionSkeleton";
import { useConnectionStatus } from "./useConnectionStatus";

type ConnectionProps = { profileId: string; compact?: boolean };

export function GitLabConnection(props: ConnectionProps) {
  return <GitLabConnectionSession key={props.profileId} {...props} />;
}

function GitLabConnectionSession({ profileId, compact = false }: ConnectionProps) {
  const {
    busy,
    setBusy,
    selectAccount,
    status,
    setStatus,
    statusLoading,
    loading,
    profile,
    error,
    setError,
    alive,
    current,
    retryStatus,
  } = useConnectionStatus<GitLabStatus, GitLabAccountProfile, GitLabSignIn>(
    profileId,
    window.eda.gitlab,
    t("settings.gitLabConnection.loadFailed"),
  );
  const [pending, setPending] = useState<GitLabSignIn | null>(null);
  const hue = useAppStore((state) => state.activeIdentity?.hue ?? 210);
  const [expanded, setExpanded] = useState(false);
  const [connectRequested, setConnectRequested] = useState(false);
  const connected = status?.account?.state === "connected";

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!active || current.current?.id !== pending.id) return;

      try {
        const result = await window.eda.gitlab.poll(profileId, pending.id);
        if (!active || current.current?.id !== pending.id) return;

        if (!result.ok) {
          current.current = null;
          setPending(null);
          setError(errorMessage(result.error));
        } else if (result.value.state === "connected") {
          current.current = null;
          setPending(null);
          setStatus(result.value.status);
          if (compact) setExpanded(false);
        } else timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (active) {
          void window.eda.gitlab.cancel(profileId, pending.id);
          current.current = null;
          setPending(null);
          setError(t("settings.gitLabConnection.signInFailed"));
        }
      }
    };

    timer = setTimeout(() => void poll(), 1000);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending, profileId, compact]);

  const openBrowser = async (signIn: GitLabSignIn, copyUrl = false) => {
    try {
      const result = await (copyUrl
        ? window.eda.gitlab.openAuthorization(profileId, signIn.id, true)
        : window.eda.gitlab.openAuthorization(profileId, signIn.id));
      if (alive.current && current.current?.id === signIn.id && !result.ok)
        setError(errorMessage(result.error));
      return result.ok;
    } catch {
      if (alive.current && current.current?.id === signIn.id)
        setError(t("settings.gitLabConnection.openFailed"));
    }
    return false;
  };

  const begin = async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.gitlab.begin(profileId);

      if (!alive.current) {
        if (result.ok) void window.eda.gitlab.cancel(profileId, result.value.id);
        return;
      }

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      current.current = result.value;
      setPending(result.value);
      await openBrowser(result.value);
    } catch {
      if (alive.current) setError(t("settings.gitLabConnection.signInFailed"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!connectRequested || !status) return;
    setConnectRequested(false);
    if (!connected && !busy && !pending && status.secureStorage) void begin();
  }, [connectRequested, status, connected, busy, pending]);

  const cancel = () => {
    if (current.current) void window.eda.gitlab.cancel(profileId, current.current.id);
    current.current = null;
    setPending(null);
    setError(null);
    setExpanded(false);
    setConnectRequested(false);
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.gitlab.disconnect(profileId);
      if (!alive.current) return;

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      setStatus((value) => value && { ...value, account: null });
      if (status?.alternatives?.length) retryStatus();
      setExpanded(false);
      setConnectRequested(false);
    } catch {
      if (alive.current) setError(t("settings.gitLabConnection.disconnectFailed"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const openProfile = async (copyUrl = false) => {
    try {
      const result = await (copyUrl
        ? window.eda.gitlab.openProfile(profileId, true)
        : window.eda.gitlab.openProfile(profileId));
      if (alive.current && !result.ok) setError(errorMessage(result.error));
      return result.ok;
    } catch {
      if (alive.current) setError(t("settings.gitLabConnection.openFailed"));
    }
    return false;
  };

  const account = status?.account;
  const details = profile?.id === account?.id ? profile : null;
  const accountProfile = account ? (
    <ConnectionProfile
      loading={loading}
      login={account.login}
      name={details?.name}
      bio={details?.bio}
      location={details?.location}
      avatarDataUrl={details?.avatarDataUrl}
      hue={hue}
      connected={connected}
      profileLabel={t("settings.gitLabConnection.viewProfile", { login: account.login })}
      profileLink={{
        onOpen: () => void openProfile(),
        onCopy: () => openProfile(true),
      }}
    />
  ) : null;

  return (
    <ServiceAccountCard
      provider="GitLab"
      compact={compact}
      open={expanded}
      onOpenChange={(open) => {
        setExpanded(open);
        setConnectRequested(open);
      }}
      completedLabel={connected ? t("settings.gitLabConnection.connected") : undefined}
      actionsPlacement={pending ? "body" : "header"}
      bodyOpen={!!pending || !!error || !!(status && !status.secureStorage)}
      summary={accountProfile}
      pendingLabel={
        (loading && compact) || busy || pending ? t("settings.gitLabConnection.waiting") : undefined
      }
      actions={
        pending ? (
          <>
            <ExternalLinkButton
              size="sm"
              variant="secondary"
              onOpen={() => void openBrowser(pending)}
              onCopy={() => openBrowser(pending, true)}
            >
              {t("settings.gitLabConnection.openGitLab")}
            </ExternalLinkButton>

            <Button size="sm" variant="ghost" onClick={cancel}>
              {t("common.cancel")}
            </Button>
          </>
        ) : loading && !status?.account ? (
          <ConnectionActionSkeleton label={t("settings.gitLabConnection.signIn")} />
        ) : status ? (
          <>
            {!compact && (
              <AccountActions
                canAdd={!!account}
                secureStorage={status.secureStorage}
                alternatives={status.alternatives ?? []}
                busy={busy}
                onAdd={begin}
                onSelect={selectAccount}
              />
            )}
            {!connected && (
              <Button
                size="sm"
                busy={busy}
                disabled={!status.secureStorage}
                onClick={() => void begin()}
              >
                {status.account
                  ? t("settings.gitLabConnection.reconnect")
                  : t("settings.gitLabConnection.signIn")}
              </Button>
            )}

            {status.account &&
              (compact ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>
                  {t("settings.gitLabConnection.disconnect")}
                </Button>
              ) : (
                <ActionsMenu
                  label={t("settings.connections.manage", { provider: "GitLab" })}
                  disabled={busy}
                  items={[
                    {
                      label: t("settings.gitLabConnection.disconnect"),
                      icon: <Unplug size={14} />,
                      danger: true,
                      onSelect: () => void disconnect(),
                    },
                  ]}
                />
              ))}
          </>
        ) : undefined
      }
    >
      {!status && !statusLoading && (
        <Button size="sm" onClick={retryStatus}>
          {t("common.retry")}
        </Button>
      )}

      {error && (
        <p role="alert" className="text-xs text-git-deleted">
          {error}
        </p>
      )}

      {pending && (
        <p className="text-xs text-text-secondary">
          {t("settings.gitLabConnection.authorizeInBrowser")}
        </p>
      )}

      {compact && !pending && accountProfile}

      {status && !status.secureStorage && (
        <p className="text-xs text-git-modified">{t("settings.gitLabConnection.unlockStorage")}</p>
      )}
    </ServiceAccountCard>
  );
}
