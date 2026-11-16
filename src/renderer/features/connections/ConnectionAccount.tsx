import type { ExternalLinkTarget } from "../../components/ui/actions/ExternalLinkButton";
import { t } from "@shared/i18n";
import type { AccentColor } from "@shared/preferences/accent";
import { ProfileAvatar } from "../../components/ui/display/ProfileAvatar";
import { ExternalLinkButton } from "../../components/ui/index";
import { cx } from "../../components/ui/cx";

export function ConnectionAccount({
  login,
  name,
  avatarDataUrl,
  hue,
  connected,
  profileLabel,
  avatarName,
  disabled = false,
  loading = false,
  profileLink,
}: {
  login: string;
  name?: string | null | undefined;
  avatarDataUrl?: string | null | undefined;
  hue: AccentColor;
  connected: boolean;
  profileLabel: string;
  avatarName?: string;
  disabled?: boolean;
  loading?: boolean;
  profileLink: ExternalLinkTarget;
}) {
  return (
    <div aria-busy={loading} className="flex min-w-0 items-center gap-2.5">
      <ProfileAvatar
        loading={loading}
        name={avatarName ?? name ?? login}
        hue={hue}
        imageUrl={avatarDataUrl ?? undefined}
      />

      <div className="min-w-0">
        {name && (
          <p
            title={name}
            className={cx(
              "truncate text-sm font-medium text-text-primary",
              loading && "ui-skeleton rounded-sm",
            )}
          >
            <span className={loading ? "invisible" : undefined}>{name}</span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <ExternalLinkButton
            {...profileLink}
            trailingIcon
            aria-label={profileLabel}
            disabled={disabled || loading}
            className={cx(
              "min-h-6 max-w-full truncate border-0 p-0 text-left",
              loading && "ui-skeleton rounded-sm",
              !name && "text-sm font-medium text-text-primary",
            )}
          >
            <span className={loading ? "invisible" : undefined}>@{login}</span>
          </ExternalLinkButton>

          {!connected && (
            <p role="status" className="text-xs text-git-modified">
              {t("settings.connections.reconnectRequired")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
