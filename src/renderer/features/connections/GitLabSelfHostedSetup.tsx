import { t } from "@shared/i18n";
import {
  normalizeGitLabInstanceUrl,
  type GitLabTokenForm,
} from "@shared/integrations/gitlab-self-hosted";
import { useState } from "react";
import { Checkbox, ExternalLinkButton } from "../../components/ui/index";
import { ConnectionSetup } from "./ConnectionSetup";

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
  const [ignoreTlsErrors, setIgnoreTlsErrors] = useState(initialIgnoreTlsErrors);

  return (
    <ConnectionSetup
      label={t("settings.gitLabSelfHosted.setupTitle")}
      urlLabel={t("settings.gitLabSelfHosted.instanceUrl")}
      urlPlaceholder={t("settings.gitLabSelfHosted.instancePlaceholder")}
      initialUrl={initialBaseUrl}
      normalizeUrl={normalizeGitLabInstanceUrl}
      busy={busy}
      error={error}
      canConnect={secureStorage}
      connectLabel={t("settings.gitLabSelfHosted.finishConnect")}
      tokenLabel={t("settings.gitLabSelfHosted.token")}
      onConnect={(_address, token, url) => onConnect(url, token.trim(), ignoreTlsErrors)}
      onUrlChange={() => setIgnoreTlsErrors(false)}
      onClearError={onClearError}
      onClose={onClose}
      renderTokenActions={(url) => (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ExternalLinkButton
              size="sm"
              variant="ghost"
              disabled={busy}
              onOpen={() => void onOpenTokenSettings(url, "legacy")}
              onCopy={() => onOpenTokenSettings(url, "legacy", true)}
            >
              {t("settings.gitLabSelfHosted.legacyToken")}
            </ExternalLinkButton>

            <ExternalLinkButton
              size="sm"
              variant="quiet"
              disabled={busy}
              onOpen={() => void onOpenTokenSettings(url, "granular")}
              onCopy={() => onOpenTokenSettings(url, "granular", true)}
            >
              {t("settings.gitLabSelfHosted.chooseTokenType")}
            </ExternalLinkButton>
          </div>

          <ExternalLinkButton
            size="sm"
            variant="quiet"
            disabled={busy}
            onOpen={() => void onOpenTokenSettings(url, "older")}
            onCopy={() => onOpenTokenSettings(url, "older", true)}
          >
            {t("settings.gitLabSelfHosted.olderGitLab")}
          </ExternalLinkButton>
        </>
      )}
      renderOptions={(showCredentials) => (
        <>
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

          {showCredentials && !secureStorage && (
            <p className="text-xs text-git-modified">
              {t("settings.gitLabConnection.unlockStorage")}
            </p>
          )}
        </>
      )}
    />
  );
}
