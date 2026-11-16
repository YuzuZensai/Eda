import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { GitHubAccountProfile, GitHubSignIn, GitHubStatus } from "@shared/integrations/github";
import { CopyIcon as Copy, UnplugIcon as Unplug } from "../../components/ui/icons";
import { useEffect, useState } from "react";
import { ConnectionProfile } from "./ConnectionProfile";
import {
  ExternalLinkButton,
  Button,
  CodeBlock,
  CopyButton,
  ActionsMenu,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { ServiceAccountCard } from "./ServiceAccountCard";
import { ConnectionActionSkeleton } from "./ConnectionSkeleton";
import { useConnectionStatus } from "./useConnectionStatus";

type ConnectionProps = { profileId: string; compact?: boolean };

export function GitHubConnection(props: ConnectionProps) {
  return <GitHubConnectionSession key={props.profileId} {...props} />;
}

function GitHubConnectionSession({ profileId, compact = false }: ConnectionProps) {
  const {
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
  } = useConnectionStatus<GitHubStatus, GitHubAccountProfile, GitHubSignIn>(
    profileId,
    window.eda.github,
    t("settings.gitHubConnection.couldNotLoadTheGitHubConnectionReopenSettingsAndTryAgain"),
  );
  const [pending, setPending] = useState<GitHubSignIn | null>(null);
  const hue = useAppStore((state) => state.activeIdentity?.hue ?? 210);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [connectRequested, setConnectRequested] = useState(false);
  const [copiedSignIn, setCopiedSignIn] = useState<string | null>(null);
  const signedIn = status?.account?.state === "connected";

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!active || current.current?.id !== pending.id) return;

      if (Date.now() >= pending.expiresAt) {
        void window.eda.github.cancel(profileId, pending.id);
        current.current = null;
        setPending(null);
        setError(t("settings.gitHubConnection.theVerificationCodeExpiredSignInWithGitHubAgain"));
        return;
      }

      try {
        const result = await window.eda.github.poll(profileId, pending.id);
        if (!active || current.current?.id !== pending.id) return;

        if (!result.ok) {
          current.current = null;
          setPending(null);
          setError(errorMessage(result.error));
        } else if (result.value.state !== "pending") {
          const connectedStatus = result.value.status;
          current.current = null;
          setPending(null);
          setStatus(connectedStatus);
        } else
          timer = setTimeout(
            () => void poll(),
            Math.min(result.value.intervalMs, Math.max(0, pending.expiresAt - Date.now())),
          );
      } catch {
        if (active) {
          void window.eda.github.cancel(profileId, pending.id);
          current.current = null;
          setPending(null);
          setError(t("settings.gitHubConnection.couldNotCompleteGitHubSignInTryAgain"));
        }
      }
    };

    timer = setTimeout(() => void poll(), pending.intervalMs);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending, profileId]);

  const openBrowser = async (signIn: GitHubSignIn, copyUrl = false) => {
    setError(null);

    try {
      const result = await (copyUrl
        ? window.eda.github.openVerification(profileId, signIn.id, true)
        : window.eda.github.openVerification(profileId, signIn.id));
      if (!alive.current || current.current?.id !== signIn.id) return false;
      if (result.ok && !copyUrl) setCopiedSignIn(signIn.id);
      else if (!result.ok) setError(errorMessage(result.error));
      return result.ok;
    } catch {
      if (alive.current && current.current?.id === signIn.id)
        setError(t("settings.gitHubConnection.couldNotCopyTheCodeAndOpenGitHubTryAgain"));
    }
    return false;
  };

  const begin = async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.github.begin(profileId);

      if (!alive.current) {
        if (result.ok) void window.eda.github.cancel(profileId, result.value.id);
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
      if (alive.current) setError(t("settings.gitHubConnection.couldNotStartGitHubSignInTryAgain"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!connectRequested || !status) return;
    setConnectRequested(false);
    if (!busy && !pending && !signedIn && status.secureStorage) void begin();
  }, [connectRequested, status, busy, pending, signedIn]);

  const cancel = () => {
    setExpanded(false);
    setConnectRequested(false);
    if (current.current) void window.eda.github.cancel(profileId, current.current.id);
    current.current = null;
    setPending(null);
    setError(null);
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.github.disconnect(profileId);
      if (!alive.current) return;

      if (result.ok) {
        setStatus((value) => value && { ...value, account: null });
        setExpanded(false);
        setConnectRequested(false);
      } else setError(errorMessage(result.error));
    } catch {
      if (alive.current) setError(t("settings.gitHubConnection.couldNotDisconnectGitHubTryAgain"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const openProfile = async (copyUrl = false) => {
    try {
      const result = await (copyUrl
        ? window.eda.github.openProfile(profileId, true)
        : window.eda.github.openProfile(profileId));
      if (alive.current && !result.ok) setError(errorMessage(result.error));
      return result.ok;
    } catch {
      if (alive.current)
        setError(t("settings.gitHubConnection.couldNotOpenTheGitHubProfileTryAgain"));
    }
    return false;
  };

  const account = status?.account;
  const isConnected = signedIn;

  useEffect(() => {
    if (isConnected) setExpanded(false);
  }, [compact, isConnected]);

  const starting = busy && !pending && !signedIn;
  const details = profile?.id === account?.id ? profile : null;
  const login = details?.login ?? account?.login;

  return (
    <ServiceAccountCard
      provider={"GitHub"}
      compact={compact}
      open={expanded}
      onOpenChange={(open) => {
        setExpanded(open);
        setConnectRequested(open);
      }}
      completedLabel={isConnected ? t("settings.gitHubConnection.gitHubConnected") : undefined}
      actionsPlacement={pending || starting ? "body" : "header"}
      contentClassName={pending ? "min-h-20" : ""}
      bodySeparator={!account || !!pending || !!error}
      bodyOpen={!!pending || starting || !!error || !!(status && !status.secureStorage)}
      summary={
        account ? (
          <ConnectionProfile
            loading={loading}
            login={login ?? account.login}
            name={details?.name}
            avatarDataUrl={details?.avatarDataUrl}
            hue={hue}
            profileLabel={t("settings.gitHubConnection.viewOnGitHub", {
              login: login ?? account.login,
            })}
            connected={isConnected}
            bio={details?.bio}
            location={details?.location}
            profileLink={{
              onOpen: () => void openProfile(),
              onCopy: () => openProfile(true),
            }}
          />
        ) : null
      }
      pendingLabel={
        starting
          ? t("settings.gitHubConnection.gettingGitHubCode")
          : pending
            ? t("settings.gitHubConnection.waitingForGitHub")
            : loading && compact
              ? t("settings.gitHubConnection.loadingGitHub")
              : undefined
      }
      actions={
        pending || starting ? (
          <>
            <ExternalLinkButton
              size="sm"
              variant="secondary"
              disabled={!pending}
              onOpen={() => pending && void openBrowser(pending)}
              onCopy={() => (pending ? openBrowser(pending, true) : Promise.resolve(false))}
            >
              {t("settings.gitHubConnection.openGitHub")}
            </ExternalLinkButton>

            <Button size="sm" variant="ghost" disabled={starting} onClick={cancel}>
              {t("common.cancel")}
            </Button>
          </>
        ) : loading && compact ? null : loading && !account ? (
          <ConnectionActionSkeleton label={t("settings.gitHubConnection.signInWithGitHub")} />
        ) : status ? (
          <>
            {!isConnected && !compact && (
              <Button
                size="sm"
                busy={busy}
                disabled={!status.secureStorage}
                onClick={() => void begin()}
              >
                {compact
                  ? account
                    ? t("settings.gitHubConnection.reconnect")
                    : t("settings.gitHubConnection.connect")
                  : account
                    ? t("settings.gitHubConnection.reconnectGitHub")
                    : t("settings.gitHubConnection.signInWithGitHub")}
              </Button>
            )}

            {account &&
              (compact ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("settings.gitHubConnection.disconnectGitHub")}
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  {t("settings.gitHubConnection.disconnect")}
                </Button>
              ) : (
                <ActionsMenu
                  label={t("settings.connections.manage", { provider: "GitHub" })}
                  disabled={busy}
                  items={[
                    {
                      label: t("settings.gitHubConnection.disconnect"),
                      icon: <Unplug size={14} />,
                      danger: true,
                      onSelect: () => void disconnect(),
                    },
                  ]}
                />
              ))}
          </>
        ) : null
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

      {account && compact ? (
        <div>
          <ConnectionProfile
            loading={loading}
            key={account.id}
            login={login ?? account.login}
            name={details?.name}
            bio={details?.bio}
            location={details?.location}
            avatarDataUrl={details?.avatarDataUrl}
            hue={hue}
            profileLabel={t("settings.gitHubConnection.viewOnGitHub", {
              login: login ?? account.login,
            })}
            profileLink={{
              onOpen: () => void openProfile(),
              onCopy: () => openProfile(true),
            }}
          />
        </div>
      ) : null}

      {status && !status.secureStorage && (
        <p className="text-xs text-git-modified">
          {t("settings.gitHubConnection.unlockYourOsKeychainAndRestartEdaToSaveAGitHubLogin")}
        </p>
      )}

      {pending || starting ? (
        <div className="max-w-sm space-y-3" aria-busy={starting}>
          <p className="text-xs text-text-secondary">
            {t("settings.gitHubConnection.enterThisCodeOnGitHub", {
              value1:
                pending && copiedSignIn === pending.id
                  ? t("gitHubConnection.codeCopiedToClipboard")
                  : "",
            })}
          </p>

          <div className="relative">
            <CodeBlock
              label={t("settings.gitHubConnection.gitHubVerificationCode")}
              className="pr-12"
            >
              {pending ? (
                pending.userCode
              ) : (
                <span aria-hidden="true" className="inline-flex items-center align-middle">
                  <span className="ui-skeleton inline-block h-[1em] w-[4ch] rounded-sm bg-border-subtle" />
                  <span className="text-text-tertiary">-</span>
                  <span className="ui-skeleton inline-block h-[1em] w-[4ch] rounded-sm bg-border-subtle" />
                </span>
              )}
            </CodeBlock>

            <div className="absolute inset-y-0 right-1 flex items-center">
              {pending ? (
                <CopyButton
                  key={pending.id}
                  value={pending.userCode}
                  copied={copiedSignIn === pending.id}
                  label={t("settings.gitHubConnection.copyCode")}
                />
              ) : (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("settings.gitHubConnection.copyCode")}
                  disabled
                >
                  <Copy size={14} aria-hidden="true" />
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </ServiceAccountCard>
  );
}
