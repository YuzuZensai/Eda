import { t } from "@shared/i18n";
import {
  normalizeGitLabInstanceUrl,
  type GitLabTokenForm,
} from "@shared/integrations/gitlab-self-hosted";
import { useState } from "react";
import { Button, Checkbox } from "../../components/ui/index";
import { GitLabSelfHostedSetupStep } from "./GitLabSelfHostedSetupStep";

interface Props {
  initialBaseUrl: string;
  initialIgnoreTlsErrors: boolean;
  secureStorage: boolean;
  busy: boolean;
  error: string | null;
  onConnect(baseUrl: string, token: string, ignoreTlsErrors: boolean): Promise<void>;
  onOpenTokenSettings(baseUrl: string, form: GitLabTokenForm, copyUrl?: boolean): Promise<boolean>;
  onClose(): void;
  onClearError(): void;
}

export function GitLabSelfHostedSetup({
  initialBaseUrl,
  initialIgnoreTlsErrors,
  secureStorage,
  busy,
  error,
  onConnect,
  onOpenTokenSettings,
  onClose,
  onClearError,
}: Props) {
  const [step, setStep] = useState<1 | 2>(initialBaseUrl ? 2 : 1);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [token, setToken] = useState("");
  const [ignoreTlsErrors, setIgnoreTlsErrors] = useState(initialIgnoreTlsErrors);
  const instance = normalizeGitLabInstanceUrl(baseUrl);
  const canContinue = !busy && !!instance && (step === 1 || (!!token.trim() && secureStorage));

  const connect = async () => {
    try {
      await onConnect(baseUrl.trim(), token.trim(), ignoreTlsErrors);
    } finally {
      setToken("");
    }
  };

  const next = () => {
    if (!canContinue) return;

    onClearError();

    if (step === 1) setStep(2);
    else void connect();
  };

  return (
    <section aria-label={t("settings.gitLabSelfHosted.setupTitle")} className="max-w-md space-y-3">
      {step > 1 && (
        <p className="truncate text-xs text-text-tertiary" title={instance ?? undefined}>
          {instance}
        </p>
      )}

      <div
        className="space-y-3"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;

          event.preventDefault();
          event.stopPropagation();
          next();
        }}
      >
        <GitLabSelfHostedSetupStep
          key={step}
          step={step}
          baseUrl={baseUrl}
          token={token}
          busy={busy}
          onBaseUrlChange={(value) => {
            setBaseUrl(value);
            setToken("");
            setIgnoreTlsErrors(false);
          }}
          onTokenChange={setToken}
          onOpenTokenSettings={(form, copyUrl) =>
            onOpenTokenSettings(baseUrl.trim(), form, copyUrl)
          }
        />

        <Checkbox
          checked={ignoreTlsErrors}
          disabled={busy}
          onChange={(event) => {
            setIgnoreTlsErrors(event.target.checked);
            onClearError();
          }}
        >
          {t("settings.gitLabSelfHosted.ignoreTlsErrors")}
        </Checkbox>

        {step === 2 && !secureStorage && (
          <p className="text-xs text-git-modified">
            {t("settings.gitLabConnection.unlockStorage")}
          </p>
        )}

        {error && (
          <p role="alert" className="text-xs text-git-deleted">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" busy={busy} disabled={!canContinue} onClick={next}>
            {t(step === 1 ? "common.next" : "settings.gitLabSelfHosted.finishConnect")}
          </Button>

          {step > 1 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setToken("");
                setStep(1);
                onClearError();
              }}
            >
              {t("common.back")}
            </Button>
          )}

          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </section>
  );
}
