import { t } from "@shared/i18n";
import type { ReactNode } from "react";
import { CheckIcon as Check } from "../../components/ui/icons";
import { Button, Disclosure, Skeleton } from "../../components/ui/index";

export function ConnectionCard({
  title,
  icon,
  completedLabel,
  status,
  children,
  onOpenChange,
  open,
}: {
  title: string;
  icon: ReactNode;
  completedLabel?: string | undefined;
  children?: ReactNode;
  status?: ReactNode;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const heading = (
    <>
      {icon}
      <span className="flex-1 text-sm font-medium text-text-primary">{title}</span>
      {status ||
        (completedLabel && (
          <span
            role="status"
            aria-label={completedLabel}
            title={completedLabel}
            className="text-git-added"
          >
            <Check size={16} aria-hidden="true" />
          </span>
        ))}
      {!children && (
        <span className="text-xs text-text-tertiary">
          {t("settings.connectionCard.comingSoon")}
        </span>
      )}
    </>
  );

  return (
    <Disclosure
      open={open}
      title={heading}
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
      className="rounded-md border border-border-subtle bg-bg-surface"
      summaryClassName="px-3 py-3"
      aria-label={t("settings.connectionCard.setup", { title: title })}
    >
      <div className="space-y-3 border-t border-border-subtle p-3">
        {children ?? (
          <p className="text-xs text-text-tertiary">{t("settings.connectionCard.comingSoon")}</p>
        )}
      </div>
    </Disclosure>
  );
}

export function ConnectionActionSkeleton({ label }: { label: string }) {
  return (
    <Skeleton className="h-auto w-fit rounded-sm">
      <Button size="sm" disabled className="invisible">
        {label}
      </Button>
    </Skeleton>
  );
}
