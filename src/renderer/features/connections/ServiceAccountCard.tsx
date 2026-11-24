import { t } from "@shared/i18n";
import type { ReactNode } from "react";
import { ProviderIcon, type HostingProvider } from "./ProviderIcon";
import { cx } from "../../components/ui/cx";
import { ConnectionCard } from "./ConnectionCard";
import { ActionIndicator, AnimatedSize, Button, Select } from "../../components/ui/index";

export function ServiceAccountCard({
  provider,
  title,
  children,
  actions,
  actionsPlacement = "header",
  status,
  pendingLabel,
  contentClassName,
  compact = false,
  completedLabel,
  onOpenChange,
  open,
  summary,
  bodyOpen = true,
  bodySeparator = true,
}: {
  provider: HostingProvider;
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  actionsPlacement?: "header" | "body";
  status?: ReactNode;
  pendingLabel?: string | undefined;
  contentClassName?: string;
  compact?: boolean;
  completedLabel?: string | undefined;
  open?: boolean | undefined;
  summary?: ReactNode;
  bodyOpen?: boolean;
  bodySeparator?: boolean;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const icon = <ProviderIcon provider={provider} />;
  const indicator =
    status ??
    (pendingLabel && (
      <span role="status" aria-label={pendingLabel} className="text-text-tertiary">
        <ActionIndicator state="pending" />
      </span>
    ));

  if (compact)
    return (
      <ConnectionCard
        title={title ?? provider}
        icon={icon}
        completedLabel={completedLabel}
        status={indicator}
        onOpenChange={onOpenChange}
        open={open}
      >
        {children}
        {actions && <footer className="flex flex-wrap items-center gap-2 pt-1">{actions}</footer>}
      </ConnectionCard>
    );

  return (
    <section
      aria-label={title ?? t("settings.serviceAccountCard.connection", { provider })}
      className="min-w-0 rounded-lg border border-border-subtle bg-bg-surface"
    >
      <AnimatedSize>
        <div className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2">
          <h2 className="flex min-h-8 min-w-0 flex-1 items-center gap-2 text-sm font-medium">
            {icon}
            {title ?? provider}
          </h2>

          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
            {indicator}
            {actionsPlacement === "header" && actions}
          </div>
        </div>

        {summary && <div className="min-w-0 px-3 pb-3 text-xs text-text-tertiary">{summary}</div>}

        {bodyOpen && children && (
          <div
            className={cx(
              "min-w-0 space-y-3 px-3 pb-3",
              bodySeparator && "border-t border-border-subtle pt-3",
              contentClassName,
            )}
          >
            {children}
            {actionsPlacement === "body" && actions && (
              <footer className="flex flex-wrap items-center gap-2 pt-1">{actions}</footer>
            )}
          </div>
        )}
      </AnimatedSize>
    </section>
  );
}

export function AccountActions({
  canAdd,
  secureStorage,
  alternatives,
  busy,
  onAdd,
  onSelect,
}: {
  canAdd: boolean;
  secureStorage: boolean;
  alternatives: readonly { id: string; login: string }[];
  busy: boolean;
  onAdd: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {canAdd && (
        <Button size="sm" variant="ghost" disabled={busy || !secureStorage} onClick={onAdd}>
          {t("providerAccount.add")}
        </Button>
      )}
      {alternatives.length > 0 && (
        <Select
          aria-label={t("providerAccount.switch")}
          value=""
          disabled={busy}
          onValueChange={onSelect}
        >
          <option value="">{t("providerAccount.switch")}</option>
          {alternatives.map(({ id, login }) => (
            <option key={id} value={id}>
              {login}
            </option>
          ))}
        </Select>
      )}
    </>
  );
}
