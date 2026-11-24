import { t } from "@shared/i18n";
import { useState, type ReactNode } from "react";
import { Button, Field, Input } from "../../components/ui/index";

export function ConnectionSetup({
  label,
  urlLabel,
  urlPlaceholder,
  initialUrl = "",
  normalizeUrl,
  busy,
  error,
  canConnect,
  connectLabel,
  tokenLabel,
  credentials,
  renderTokenActions,
  renderOptions,
  onConnect,
  onUrlChange,
  onClearError,
  onClose,
}: {
  label: string;
  urlLabel: string;
  urlPlaceholder?: string;
  initialUrl?: string;
  normalizeUrl: (url: string) => string | null;
  busy: boolean;
  error: string | null;
  canConnect: boolean;
  connectLabel: string;
  tokenLabel: string;
  credentials?: ReactNode;
  renderTokenActions?: (url: string) => ReactNode;
  renderOptions?: (showCredentials: boolean) => ReactNode;
  onConnect: (address: string, token: string, url: string) => Promise<void>;
  onUrlChange?: () => void;
  onClearError: () => void;
  onClose: (() => void) | undefined;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState("");
  const [showCredentials, setShowCredentials] = useState(!!initialUrl);
  const address = normalizeUrl(url);
  const canContinue = !busy && !!address && (!showCredentials || (canConnect && !!token.trim()));

  const connect = async (address: string) => {
    try {
      await onConnect(address, token, url.trim());
    } finally {
      setToken("");
    }
  };

  const next = () => {
    if (!canContinue) return;

    onClearError();

    if (showCredentials) void connect(address);
    else setShowCredentials(true);
  };

  return (
    <section
      aria-label={label}
      className="max-w-md space-y-3"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;

        event.preventDefault();
        event.stopPropagation();
        next();
      }}
    >
      {showCredentials ? (
        <>
          <p className="truncate text-xs text-text-tertiary" title={address ?? undefined}>
            {address}
          </p>

          <div className="space-y-2">
            {credentials}

            <Field label={tokenLabel}>
              {(field) => (
                <Input
                  {...field}
                  autoFocus={!credentials}
                  type="password"
                  value={token}
                  disabled={busy}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => setToken(event.target.value)}
                />
              )}
            </Field>

            {renderTokenActions?.(url.trim())}
          </div>
        </>
      ) : (
        <Field label={urlLabel}>
          {(field) => (
            <Input
              {...field}
              autoFocus
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={url}
              placeholder={urlPlaceholder}
              onChange={(event) => {
                setUrl(event.target.value);
                onUrlChange?.();
              }}
            />
          )}
        </Field>
      )}

      {renderOptions?.(showCredentials)}

      {error && (
        <p role="alert" className="text-xs text-git-deleted">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" busy={busy} disabled={!canContinue} onClick={next}>
          {showCredentials ? connectLabel : t("common.next")}
        </Button>

        {showCredentials && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setToken("");
              setShowCredentials(false);
              onClearError();
            }}
          >
            {t("common.back")}
          </Button>
        )}

        <Button size="sm" variant="ghost" disabled={!onClose} onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </section>
  );
}
