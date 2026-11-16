import { t } from "@shared/i18n";
import type { GitLabTokenForm } from "@shared/integrations/gitlab-self-hosted";
import { ExternalLinkButton, Field, Input } from "../../components/ui/index";

interface Props {
  step: number;
  baseUrl: string;
  token: string;
  busy: boolean;
  onBaseUrlChange(value: string): void;
  onTokenChange(value: string): void;
  onOpenTokenSettings(form: GitLabTokenForm, copyUrl?: boolean): Promise<boolean>;
}

export function GitLabSelfHostedSetupStep({
  step,
  baseUrl,
  token,
  busy,
  onBaseUrlChange,
  onTokenChange,
  onOpenTokenSettings,
}: Props) {
  if (step === 1)
    return (
      <Field label={t("settings.gitLabSelfHosted.instanceUrl")}>
        {(field) => (
          <Input
            {...field}
            autoFocus
            value={baseUrl}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("settings.gitLabSelfHosted.instancePlaceholder")}
            onChange={(event) => onBaseUrlChange(event.target.value)}
          />
        )}
      </Field>
    );

  return (
    <div className="space-y-2">
      <Field label={t("settings.gitLabSelfHosted.token")}>
        {(field) => (
          <Input
            {...field}
            autoFocus
            type="password"
            value={token}
            disabled={busy}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => onTokenChange(event.target.value)}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <ExternalLinkButton
          size="sm"
          variant="ghost"
          disabled={busy}
          onOpen={() => void onOpenTokenSettings("legacy")}
          onCopy={() => onOpenTokenSettings("legacy", true)}
        >
          {t("settings.gitLabSelfHosted.legacyToken")}
        </ExternalLinkButton>

        <ExternalLinkButton
          size="sm"
          variant="quiet"
          disabled={busy}
          onOpen={() => void onOpenTokenSettings("granular")}
          onCopy={() => onOpenTokenSettings("granular", true)}
        >
          {t("settings.gitLabSelfHosted.chooseTokenType")}
        </ExternalLinkButton>
      </div>

      <ExternalLinkButton
        size="sm"
        variant="quiet"
        disabled={busy}
        onOpen={() => void onOpenTokenSettings("older")}
        onCopy={() => onOpenTokenSettings("older", true)}
      >
        {t("settings.gitLabSelfHosted.olderGitLab")}
      </ExternalLinkButton>
    </div>
  );
}
