import { useState } from "react";
import { errorMessage, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  gitHostBase,
  gitHostKinds,
  type GitHost,
  type GitHostKind,
  type GitHostPage,
} from "@shared/integrations/git-host";
import {
  Button,
  Disclosure,
  Field,
  Input,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { ConnectionSetup } from "./ConnectionSetup";
import { ServiceAccountCard } from "./ServiceAccountCard";

const hostProviders = {
  "github-enterprise": ["hosts.githubEnterprise", "GitHub Enterprise", "hosts.base"],
  "bitbucket-cloud": ["hosts.bitbucketCloud", "Bitbucket", "hosts.workspaceUrl"],
  "bitbucket-server": ["hosts.bitbucketServer", "Bitbucket", "hosts.base"],
  azure: ["hosts.azure", "Azure DevOps", "hosts.projectUrl"],
} as const;

const readAccounts = (id: string) => window.eda.gitHosts.accounts(id);

function accountReadError(error: string | undefined, retry: () => void, className = "") {
  return (
    error && (
      <StateMessage
        title={error}
        tone="error"
        className={className}
        action={<TextButton onClick={retry}>{t("common.retry")}</TextButton>}
      />
    )
  );
}

function hostActionError(error: string) {
  return (
    error && (
      <p role="alert" className="text-xs text-git-deleted">
        {error}
      </p>
    )
  );
}

function useGitHostAction() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async <Value,>(
    work: () => Promise<Result<Value>>,
    onSuccess: (value: Value) => void,
  ) => {
    if (busy) return;

    setBusy(true);
    setError("");

    try {
      const result = await work();
      if (result.ok) onSuccess(result.value);
      else setError(errorMessage(result.error));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, setError, run };
}

function GitHostAccounts({
  accounts,
  action,
  busy,
  onAction,
}: {
  accounts: readonly GitHost[];
  action: string;
  busy: boolean;
  onAction: (base: string) => void;
}) {
  return (
    <ul className="divide-y divide-border-subtle">
      {accounts.map((account) => (
        <li key={account.base} className="flex flex-wrap items-center justify-between gap-x-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">{account.username}</p>
            <p className="truncate text-xs text-text-tertiary" title={account.base}>
              {account.base}
            </p>
          </div>

          <TextButton disabled={busy} onClick={() => onAction(account.base)}>
            {action}
          </TextButton>
        </li>
      ))}
    </ul>
  );
}

export function AdditionalGitHostCards({ profileId }: { profileId: string }) {
  const accounts = useRepositoryRead(readAccounts, profileId);
  const loading = !accounts.value && !accounts.error;

  return (
    <>
      {gitHostKinds.map((kind) => (
        <GitHostCard
          key={kind}
          kind={kind}
          profileId={profileId}
          accounts={accounts.value?.filter((account) => account.kind === kind) ?? []}
          loading={loading}
          onChange={accounts.retry}
        />
      ))}

      {accountReadError(accounts.error, accounts.retry, "col-span-full")}
    </>
  );
}

function GitHostCard({
  kind,
  profileId,
  accounts,
  loading,
  onChange,
}: {
  kind: GitHostKind;
  profileId: string;
  accounts: readonly GitHost[];
  loading: boolean;
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [username, setUsername] = useState("");
  const { busy, error, setError, run } = useGitHostAction();
  const [titleKey, provider, baseLabel] = hostProviders[kind];
  const title = t(titleKey);

  const close = () => {
    setExpanded(false);
    setUsername("");
    setError("");
  };

  const connect = (address: string, token: string) =>
    run(
      () => window.eda.gitHosts.connect(profileId, { kind, base: address, username }, token),
      () => {
        close();
        onChange();
      },
    );

  const disconnect = (address: string) =>
    void run(() => window.eda.gitHosts.disconnect(profileId, address), onChange);

  return (
    <ServiceAccountCard
      provider={provider}
      title={title}
      summary={
        accounts.length > 0 && (
          <GitHostAccounts
            accounts={accounts}
            action={t("hosts.disconnect")}
            busy={busy}
            onAction={disconnect}
          />
        )
      }
      bodyOpen={expanded || !!error}
      actions={
        !expanded && (
          <Button
            size="sm"
            busy={loading || busy}
            onClick={() => {
              setExpanded(true);
              setError("");
            }}
          >
            {t("hosts.add")}
          </Button>
        )
      }
    >
      {expanded ? (
        <ConnectionSetup
          label={t("settings.connectionCard.setup", { title })}
          urlLabel={t(baseLabel)}
          normalizeUrl={(url) => gitHostBase(kind, url)}
          busy={busy}
          error={error}
          canConnect={!!username}
          connectLabel={t("hosts.connect")}
          tokenLabel={t("hosts.token")}
          onConnect={connect}
          onClearError={() => setError("")}
          onClose={busy ? undefined : close}
          credentials={
            <Field
              label={t(kind === "bitbucket-cloud" ? "hosts.atlassianEmail" : "hosts.username")}
            >
              {(field) => (
                <Input
                  {...field}
                  autoFocus
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              )}
            </Field>
          }
        />
      ) : (
        hostActionError(error)
      )}
    </ServiceAccountCard>
  );
}

export function AdditionalGitHosts({
  profileId,
  onSelect,
}: {
  profileId: string;
  onSelect: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const accounts = useRepositoryRead(readAccounts, expanded ? profileId : null);
  const [page, setPage] = useState<GitHostPage | null>(null);
  const nextPage = page?.next ?? null;
  const [host, setHost] = useState("");
  const { busy, error, run } = useGitHostAction();

  const browse = (address: string, offset: number | string) =>
    void run(() => {
      if (address !== host || !offset) setPage(null);
      setHost(address);
      return window.eda.gitHosts.repositories(profileId, address, offset);
    }, setPage);

  return (
    <Disclosure
      title={t("hosts.title")}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      {expanded && (
        <div className="space-y-2">
          {accountReadError(accounts.error, accounts.retry)}

          {!!accounts.value?.length && (
            <GitHostAccounts
              accounts={accounts.value}
              action={t("hosts.repositories")}
              busy={busy}
              onAction={(address) => browse(address, 0)}
            />
          )}

          {page && (
            <>
              <ul>
                {page.entries.map((entry) => (
                  <li key={entry.url}>
                    <TextButton disabled={busy} onClick={() => onSelect(entry.url)}>
                      {entry.name}
                    </TextButton>
                  </li>
                ))}
              </ul>

              {nextPage !== null && (
                <TextButton disabled={busy} onClick={() => browse(host, nextPage)}>
                  {t("hosts.more")}
                </TextButton>
              )}
            </>
          )}

          {hostActionError(error)}
        </div>
      )}
    </Disclosure>
  );
}
