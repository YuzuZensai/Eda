import type { ExternalLinkTarget } from "../../components/ui/actions/ExternalLinkButton";
import type { ReactNode } from "react";
import { GlobeIcon, MapPinIcon } from "../../components/ui/icons";
import type { AccentColor } from "@shared/preferences/accent";
import { cx } from "../../components/ui/cx";
import { ConnectionAccount } from "./ConnectionAccount";

function ProfileDetail({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-text-tertiary">
      <span className="mt-0.5 flex shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

export function ConnectionProfile({
  login,
  name,
  bio,
  location,
  instanceUrl,
  avatarDataUrl,
  hue,
  profileLabel,
  profileLink,
  children,
  connected = true,
  disabled = false,
  loading = false,
}: {
  login: string;
  name?: string | null | undefined;
  bio?: string | null | undefined;
  location?: string | null | undefined;
  instanceUrl?: string;
  avatarDataUrl?: string | null | undefined;
  hue: AccentColor;
  profileLabel: string;
  profileLink: ExternalLinkTarget;
  children?: ReactNode;
  connected?: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <div aria-busy={loading} className="space-y-2">
      <ConnectionAccount
        loading={loading}
        login={login}
        name={name?.trim() || login}
        avatarDataUrl={avatarDataUrl}
        hue={hue}
        connected={connected}
        disabled={disabled}
        profileLabel={profileLabel}
        profileLink={profileLink}
      />

      {(loading || bio || location) && (
        <div className="space-y-2" aria-hidden={loading}>
          {(loading || bio) && (
            <p
              title={bio ?? undefined}
              className={cx(
                "line-clamp-2 whitespace-pre-line break-words text-xs text-text-secondary",
                loading && "ui-skeleton h-8 rounded-sm",
              )}
            >
              {bio}
            </p>
          )}

          {(loading || location) && (
            <div className={cx("min-w-0", loading && "ui-skeleton h-4 w-2/3 rounded-sm")}>
              {location && (
                <p
                  title={location}
                  className="flex items-center gap-1.5 text-xs text-text-tertiary"
                >
                  <MapPinIcon size={14} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{location}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {instanceUrl && <ProfileDetail icon={<GlobeIcon size={14} />}>{instanceUrl}</ProfileDetail>}

      {children}
    </div>
  );
}
