import { useState } from "react";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { isOneOf } from "@shared/validation";
import {
  gitHostBase,
  gitHostKinds,
  type GitHostKind,
  type GitHostPage,
} from "@shared/integrations/git-host";
import {
  Disclosure,
  Field,
  Input,
  Select,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";

const hostLabels = {
  "github-enterprise": "hosts.githubEnterprise",
  "bitbucket-cloud": "hosts.bitbucketCloud",
  "bitbucket-server": "hosts.bitbucketServer",
  azure: "hosts.azure",
} as const;

export function AdditionalGitHosts({
  profileId,
  onSelect,
}: {
  profileId: string;
  onSelect?: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const accounts = useRepositoryRead(
    (id: string) => window.eda.gitHosts.accounts(id),
    expanded ? profileId : null,
  );
  const [kind, setKind] = useState<GitHostKind>("github-enterprise");
  const [base, setBase] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [page, setPage] = useState<GitHostPage | null>(null);
  const nextPage = page?.next ?? null;
  const [host, setHost] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const browse = async (address: string, offset: number | string) => {
    if (address !== host || !offset) setPage(null);
    setHost(address);
    const result = await window.eda.gitHosts.repositories(profileId, address, offset);
    if (result.ok) setPage(result.value);
    else setError(errorMessage(result.error));
  };
  return (
    <Disclosure title={t("hosts.title")} onToggle={(e) => setExpanded(e.currentTarget.open)}>
      {expanded && (
        <div className="space-y-2">
          {accounts.error && (
            <StateMessage
              title={accounts.error}
              tone="error"
              action={<TextButton onClick={accounts.retry}>{t("common.retry")}</TextButton>}
            />
          )}
          {(accounts.value ?? []).map((account) => (
            <div key={account.base} className="space-x-2">
              <span>
                {account.username} · {account.base}
              </span>
              {onSelect ? (
                <TextButton disabled={busy} onClick={() => void run(() => browse(account.base, 0))}>
                  {t("hosts.repositories")}
                </TextButton>
              ) : (
                <TextButton
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await window.eda.gitHosts.disconnect(profileId, account.base);
                      if (!result.ok) setError(errorMessage(result.error));
                      else accounts.retry();
                    })
                  }
                >
                  {t("hosts.disconnect")}
                </TextButton>
              )}
            </div>
          ))}
          {onSelect && page && (
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
                <TextButton disabled={busy} onClick={() => void run(() => browse(host, nextPage))}>
                  {t("hosts.more")}
                </TextButton>
              )}
            </>
          )}
          {!onSelect && (
            <fieldset className="space-y-2" disabled={busy}>
              <Field label={t("hosts.kind")}>
                {(field) => (
                  <Select
                    {...field}
                    value={kind}
                    onValueChange={(next) => {
                      if (isOneOf(next, gitHostKinds)) {
                        setKind(next);
                        setToken("");
                        setBase("");
                      }
                    }}
                  >
                    {gitHostKinds.map((k) => (
                      <option key={k} value={k}>
                        {t(hostLabels[k])}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t("hosts.base")}>
                {(field) => (
                  <Input {...field} value={base} onChange={(e) => setBase(e.target.value)} />
                )}
              </Field>
              <Field label={t("hosts.username")}>
                {(field) => (
                  <Input
                    {...field}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t("hosts.token")}>
                {(field) => (
                  <Input
                    {...field}
                    autoComplete="off"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                )}
              </Field>
              <TextButton
                disabled={!base || !username || !token}
                onClick={() =>
                  void run(async () => {
                    const address = gitHostBase(kind, base);
                    if (!address) {
                      setError(t("hosts.invalid"));
                      return;
                    }
                    const result = await window.eda.gitHosts.connect(
                      profileId,
                      { kind, base: address, username },
                      token,
                    );
                    setToken("");
                    if (result.ok) accounts.retry();
                    else setError(errorMessage(result.error));
                  })
                }
              >
                {t("hosts.connect")}
              </TextButton>
            </fieldset>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </Disclosure>
  );
}
