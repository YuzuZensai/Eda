import { useAvatar } from "../../../hooks/useAvatar";
import { accentComponents, type AccentColor } from "@shared/preferences/accent";
import { useState, type CSSProperties } from "react";
import { cx } from "../cx";

export function ProfileAvatar({
  name,
  hue,
  imageUrl: providedUrl,
  email,
  repositoryId,
  compact = false,
  small = false,
  loading = false,
}: {
  name: string;
  hue: AccentColor;
  imageUrl?: string | undefined;
  email?: string | undefined;
  repositoryId?: string;
  compact?: boolean;
  small?: boolean;
  loading?: boolean;
}) {
  const cachedUrl = useAvatar(email, repositoryId);
  const imageUrl = email ? cachedUrl : providedUrl;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showSkeleton = loading || (!!imageUrl && loadedUrl !== imageUrl && failedUrl !== imageUrl);
  const initials = name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const accent = accentComponents(hue);

  return (
    <span
      aria-hidden="true"
      style={
        {
          "--avatar-hue": accent.hue,
          ...(typeof hue === "string" && { "--avatar-chroma": accent.chroma }),
        } as CSSProperties
      }
      className={cx(
        "profile-avatar relative overflow-hidden flex shrink-0 items-center justify-center rounded-full font-semibold",
        compact ? "size-5 text-[9px]" : small ? "size-7 text-xs" : "size-11 text-base",
        showSkeleton && "ui-skeleton bg-border-subtle shadow-none",
      )}
    >
      {!showSkeleton && initials}
      {imageUrl && failedUrl !== imageUrl && (
        <img
          key={imageUrl}
          src={imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          className={cx(
            "absolute inset-0 size-full object-cover",
            (loading || loadedUrl !== imageUrl) && "invisible",
          )}
          onLoad={() => setLoadedUrl(imageUrl)}
          onError={() => setFailedUrl(imageUrl)}
        />
      )}
    </span>
  );
}
