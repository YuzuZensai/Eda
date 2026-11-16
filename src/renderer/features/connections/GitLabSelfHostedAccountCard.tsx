import { t } from "@shared/i18n";
import type {
  GitLabSelfHostedAccount,
  GitLabSelfHostedAccountProfile,
} from "@shared/integrations/gitlab-self-hosted";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { ConnectionProfile } from "./ConnectionProfile";
import { cx } from "../../components/ui/cx";
import { GitLabSelfHostedAccountActions } from "./GitLabSelfHostedAccountActions";

interface Props {
  profileId: string;
  account: GitLabSelfHostedAccount;
  busy: boolean;
  secureStorage: boolean;
  showActions?: boolean;
  onOpen(baseUrl: string, copyUrl?: boolean): Promise<boolean>;
  onEdit(baseUrl: string): void;
  onDisconnect(baseUrl: string): void;
}

export function GitLabSelfHostedAccountCard({
  profileId,
  account,
  busy,
  secureStorage,
  showActions = true,
  onOpen,
  onEdit,
  onDisconnect,
}: Props) {
  const { baseUrl, login, state } = account;
  const hue = useAppStore((value) => value.activeIdentity?.hue ?? 210);
  const [loaded, setLoaded] = useState<{
    profileId: string;
    account: GitLabSelfHostedAccount;
    profile: GitLabSelfHostedAccountProfile | null;
  } | null>(null);

  useEffect(() => {
    let active = true;

    void window.eda.gitlabSelfHosted
      .profile(profileId, baseUrl)
      .then((result) => {
        if (!active) return;
        const profile = result.ok ? result.value : null;
        setLoaded({
          profileId,
          account,
          profile: profile?.id === account.id && profile.baseUrl === baseUrl ? profile : null,
        });
      })
      .catch(() => {
        if (active) setLoaded({ profileId, account, profile: null });
      });

    return () => {
      active = false;
    };
  }, [profileId, account, baseUrl]);

  const ready = loaded?.profileId === profileId && loaded.account === account;
  const profile = ready ? loaded.profile : null;

  return (
    <div
      className={cx(
        "flex min-w-0 items-start justify-between gap-3",
        showActions && "py-3 first:pt-0 last:pb-0",
      )}
    >
      <div className="min-w-0 flex-1">
        <ConnectionProfile
          loading={!ready}
          login={login}
          name={profile?.name}
          bio={profile?.bio}
          location={profile?.location}
          instanceUrl={baseUrl}
          avatarDataUrl={profile?.avatarDataUrl}
          hue={hue}
          disabled={busy}
          connected={state === "connected"}
          profileLabel={t("settings.gitLabSelfHosted.viewProfile", { login, instance: baseUrl })}
          profileLink={{ onOpen: () => void onOpen(baseUrl), onCopy: () => onOpen(baseUrl, true) }}
        />
      </div>

      {showActions && (
        <div className="flex shrink-0 items-center gap-2">
          {state !== "connected" && (
            <Button size="sm" disabled={busy || !secureStorage} onClick={() => onEdit(baseUrl)}>
              {t("settings.connections.reconnect")}
            </Button>
          )}

          <GitLabSelfHostedAccountActions
            account={account}
            disabled={busy || !secureStorage}
            onEdit={onEdit}
            onDisconnect={onDisconnect}
          />
        </div>
      )}
    </div>
  );
}
