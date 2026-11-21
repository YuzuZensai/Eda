import { errorAction, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { GitHubStatus } from "@shared/integrations/github";
import {
  discoveryProviders,
  type RepositoryProvider,
} from "@shared/integrations/provider-repositories";
import type { TransportCredentials } from "@shared/integrations/remotes";
import {
  ArrowDownToLineIcon as ArrowDownToLine,
  FolderIcon as Folder,
  LinkIcon as Link,
  PlusIcon as Plus,
} from "../../components/ui/icons";
import { useEffect, useRef, useState } from "react";
import {
  Checkbox,
  Textarea,
  Button,
  Dialog,
  Disclosure,
  ErrorDialog,
  Field,
  IconButton,
  Input,
  Select,
  StateMessage,
} from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { useShellStore } from "../../stores/shell-store";
import { AdditionalGitHosts } from "../connections/AdditionalGitHosts";
import { ProviderIcon } from "../connections/ProviderIcon";
import { TransferProgress, TransportFields } from "../sync/TransportFields";
import { ProviderRepositoryBrowser } from "./ProviderRepositoryBrowser";

type Source = RepositoryProvider | "url" | `gitlab-self-hosted:${string}`;

type Connection = {
  status: GitHubStatus | null;
  error: string | null;
  provider: RepositoryProvider;
  baseUrl?: string;
};

function folderName(url: string): string {
  return (
    url
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/[\\/]+$/, "")
      .split(/[\\/:]/)
      .at(-1)
      ?.replace(/\.git$/i, "") ?? ""
  );
}

export function CloneRepositoryDialog({ onClose }: { onClose: () => void }) {
  const [profile] = useState(() => useAppStore.getState().activeIdentity!);
  const profileId = profile.id;

  const [source, setSource] = useState<Source | null>(null);
  const [connections, setConnections] = useState<Record<string, Connection> | null>(null);

  const [url, setUrl] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const parentPath = parent ?? "";
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [depth, setDepth] = useState("");
  const [sparse, setSparse] = useState(false);
  const [directories, setDirectories] = useState("");
  const [blobless, setBlobless] = useState(false);
  const [since, setSince] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [auth, setAuth] = useState<TransportCredentials>({ username: "", password: "" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentSource = source ?? "url";
  const connection = currentSource === "url" ? null : connections?.[currentSource];
  const connected = connection?.status?.account?.state === "connected";

  const sourceOptions: Source[] = [
    ...(Object.keys(connections ?? {}) as Exclude<Source, "url">[]),
    "url",
  ];

  useEffect(() => {
    let active = true;

    void window.eda.settings
      .resolve("repositoryRoot", { profileId })
      .then((result) => {
        if (!active) return;
        setParent((current) => current ?? (result.ok ? result.value.value : ""));
        if (!result.ok) setError(errorMessage(result.error));
      })
      .catch(() => {
        if (!active) return;
        setParent((current) => current ?? "");
        setError(t("settings.useScopedSetting.couldNotReadApplicationPreferences"));
      });

    return () => {
      active = false;
    };
  }, [profileId]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const providers = discoveryProviders;

      const results = await Promise.allSettled([
        ...providers.map((provider) => window.eda[provider].status(profileId)),
        window.eda.gitlabSelfHosted.status(profileId),
      ]);

      if (!active) return;

      const values = Object.fromEntries(
        providers.map((provider, index) => {
          const result = results[index]!;

          return [
            provider,
            result.status === "fulfilled" && result.value.ok
              ? { provider, status: result.value.value, error: null }
              : {
                  provider,
                  status: null,
                  error:
                    result.status === "fulfilled" && !result.value.ok
                      ? errorMessage(result.value.error)
                      : t("cloneRepositoryDialog.connectionLoadFailed"),
                },
          ];
        }),
      ) as Record<string, Connection>;

      const selfHosted = results[2];

      if (
        selfHosted?.status === "fulfilled" &&
        selfHosted.value.ok &&
        "accounts" in selfHosted.value.value
      ) {
        for (const account of selfHosted.value.value.accounts) {
          values[`gitlab-self-hosted:${account.baseUrl}`] = {
            provider: "gitlab",
            baseUrl: account.baseUrl,
            error: null,
            status: { secureStorage: selfHosted.value.value.secureStorage, account },
          };
        }
      }

      setConnections(values);

      setSource(
        (current) =>
          current ??
          (Object.keys(values).find(
            (value) => values[value]?.status?.account?.state === "connected",
          ) as Source | undefined) ??
          "url",
      );
    };

    void load();

    return () => {
      active = false;
    };
  }, [profileId]);

  const updateUrl = (value: string) => {
    setUrl(value);
    if (!nameEdited) setName(folderName(value));
  };

  const changeSource = (next: Source) => {
    if (busy) return;

    setSource(next);

    if (next === currentSource) return;

    setUrl("");
    if (!nameEdited) setName("");
    setAuth({ username: "", password: "" });
  };

  const openIntegrations = () => {
    onClose();
    useShellStore.getState().openSettings("integrations");
  };

  const foreground = useRef(true);
  useEffect(() => {
    foreground.current = true;
    return () => {
      foreground.current = false;
    };
  }, []);
  const dismiss = () => {
    foreground.current = false;
    onClose();
  };

  const clone = async () => {
    if (busy || !url.trim() || !parentPath.trim() || !name.trim()) return;

    const selection = useAppStore.getState().selectedRepositoryId;
    const canOpen = () => {
      const state = useAppStore.getState();
      return (
        foreground.current &&
        state.activeIdentity?.id === profileId &&
        state.switchingIdentityId === null &&
        state.selectedRepositoryId === selection
      );
    };
    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.remotes.clone({
        profileId,
        url: url.trim(),
        parent: parentPath.trim(),
        name: name.trim(),
        ...(branch.trim() && { branch: branch.trim() }),
        ...(depth && { depth: Number(depth) }),
        ...(sparse && { sparseDirectories: directories.split("\n").filter(Boolean) }),
        ...(blobless && { blobless }),
        ...(since && { since }),
        ...(auth.username || auth.password ? { credentials: auth } : {}),
      });

      setAuth({ username: "", password: "" });

      if (!result.ok) {
        if (!foreground.current) return;
        setError(
          t("cloneRepositoryDialog.anyIncompleteDestinationIsPreservedInspectItBefore", {
            message: errorMessage(result.error),
            value2: errorAction(result.error) ?? "",
          }),
        );

        return;
      }

      if (useAppStore.getState().activeIdentity?.id !== profileId) return;

      const openOnCompletion = canOpen();
      await useAppStore.getState().refreshRepositories();
      if (!openOnCompletion || !canOpen()) return;
      useAppStore.getState().selectRepository(result.value.id);
      onClose();
    } catch {
      setError(t("cloneRepositoryDialog.cloneFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      size="xl"
      title={t("cloneRepositoryDialog.cloneRepository")}
      onClose={dismiss}
      footer={
        <>
          {busy && (
            <div className="mr-auto">
              <TransferProgress kindKey="operationTitles.cloneRepository" showDetails={false} />
            </div>
          )}

          <Button variant="quiet" onClick={dismiss}>
            {busy ? t("cloneRepositoryDialog.background") : t("common.close")}
          </Button>

          <Button
            variant="primary"
            icon={<ArrowDownToLine size={15} />}
            busy={busy}
            disabled={
              !url.trim() ||
              !parentPath.trim() ||
              !name.trim() ||
              (!!depth &&
                (!Number.isSafeInteger(Number(depth)) ||
                  Number(depth) < 1 ||
                  Number(depth) > 2147483647))
            }
            onClick={() => void clone()}
          >
            {busy ? t("cloneRepositoryDialog.cloning") : t("cloneRepositoryDialog.cloneRepository")}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="grid overflow-hidden rounded-lg border border-border-default min-[800px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <section
            className="min-w-0 space-y-4 p-4"
            aria-label={t("cloneRepositoryDialog.repositorySource")}
          >
            <Field label={t("cloneRepositoryDialog.provider")}>
              {(field) => (
                <Select
                  {...field}
                  aria-label={t("cloneRepositoryDialog.provider")}
                  value={currentSource}
                  onValueChange={(value) => {
                    if (value === "add") openIntegrations();
                    else if (sourceOptions.includes(value as Source)) changeSource(value as Source);
                  }}
                  disabled={busy}
                  className="w-full"
                >
                  {sourceOptions
                    .filter((value) => value === "url" || connections?.[value]?.status?.account)
                    .map((value) => {
                      const account =
                        value === "url" ? null : connections?.[value]?.status?.account;

                      return (
                        <option key={value} value={value}>
                          <span className="inline-flex min-w-0 items-center gap-2">
                            {value === "url" ? (
                              <Link size={15} aria-hidden="true" />
                            ) : (
                              <ProviderIcon provider={value === "github" ? "GitHub" : "GitLab"} />
                            )}

                            <span>
                              {value === "url"
                                ? t("cloneRepositoryDialog.urlSource")
                                : value === "github"
                                  ? "GitHub"
                                  : connections?.[value]?.baseUrl
                                    ? t("settings.gitLabSelfHosted.connectionLabel", {
                                        instance: connections[value]!.baseUrl,
                                      })
                                    : "GitLab"}
                            </span>

                            {value !== "url" && (
                              <span className="truncate text-xs text-text-tertiary">
                                {!connections
                                  ? t("cloneRepositoryDialog.checkingConnection")
                                  : account?.state === "connected"
                                    ? `@${account.login}`
                                    : t(
                                        account
                                          ? "cloneRepositoryDialog.reconnect"
                                          : "cloneRepositoryDialog.notConnected",
                                      )}
                              </span>
                            )}
                          </span>
                        </option>
                      );
                    })}

                  <option value="add">
                    <span className="inline-flex items-center gap-2">
                      <Plus size={15} aria-hidden="true" />
                      {t("cloneRepositoryDialog.addProvider")}
                    </span>
                  </option>
                </Select>
              )}
            </Field>

            {currentSource === "url" ? (
              <div className="space-y-4">
                <Field
                  label={t("cloneRepositoryDialog.repositoryUrl")}
                  hint={t("cloneRepositoryDialog.anyGitRepository")}
                >
                  {(field) => (
                    <Input
                      {...field}
                      aria-label={t("cloneRepositoryDialog.repositoryUrl")}
                      value={url}
                      disabled={busy}
                      spellCheck={false}
                      autoCapitalize="none"
                      onChange={(event) => {
                        setSource("url");
                        updateUrl(event.target.value);
                      }}
                      placeholder={t("cloneRepositoryDialog.httpsHostOwnerRepositoryGit")}
                    />
                  )}
                </Field>

                {profileId && (
                  <AdditionalGitHosts key={profileId} profileId={profileId} onSelect={updateUrl} />
                )}
                <TransportFields value={auth} onChange={setAuth} disabled={busy} />
              </div>
            ) : !connections ? (
              <StateMessage
                tone="loading"
                className="min-h-[20rem]"
                title={t("cloneRepositoryDialog.checkingConnection")}
              />
            ) : connected ? (
              <ProviderRepositoryBrowser
                key={currentSource}
                profileId={profileId}
                provider={connection?.provider ?? "gitlab"}
                baseUrl={connection?.baseUrl}
                selectedUrl={url}
                disabled={busy}
                onSelect={(repository) => updateUrl(repository.cloneUrl)}
              />
            ) : (
              <StateMessage
                className="min-h-[20rem] rounded-lg border border-border-subtle bg-bg-inset/40"
                tone={connection?.error ? "error" : "info"}
                title={t("cloneRepositoryDialog.connectProvider", {
                  provider: currentSource === "github" ? "GitHub" : "GitLab",
                })}
                description={connection?.error ?? t("cloneRepositoryDialog.connectHint")}
                action={
                  <Button onClick={openIntegrations}>
                    {t("cloneRepositoryDialog.openIntegrations")}
                  </Button>
                }
              />
            )}
          </section>

          <section
            className="flex min-w-0 flex-col gap-5 border-t border-border-subtle bg-bg-inset/40 p-4 min-[800px]:border-l min-[800px]:border-t-0"
            aria-label={t("cloneRepositoryDialog.destination")}
          >
            <div className="flex items-center gap-2">
              <Folder size={16} aria-hidden="true" className="text-text-tertiary" />
              <h3 className="text-sm font-semibold">{t("cloneRepositoryDialog.destination")}</h3>
            </div>

            <Field label={t("cloneRepositoryDialog.parentFolder")}>
              {(field) => (
                <div className="flex min-w-0 gap-2">
                  <Input
                    {...field}
                    aria-label={t("cloneRepositoryDialog.cloneParentFolder")}
                    value={parentPath}
                    disabled={busy}
                    aria-busy={parent === null}
                    onChange={(event) => setParent(event.target.value)}
                    placeholder={t("cloneRepositoryDialog.chooseParentFolder")}
                  />

                  <IconButton
                    size="md"
                    variant="secondary"
                    aria-label={t("cloneRepositoryDialog.browseFolders")}
                    title={t("cloneRepositoryDialog.browseFolders")}
                    icon={<Folder size={16} />}
                    disabled={busy}
                    onClick={() => {
                      void window.eda.repository
                        .chooseFolder()
                        .then((result) => {
                          if (result.ok && result.value) setParent(result.value);
                          else if (!result.ok) setError(errorMessage(result.error));
                        })
                        .catch(() => setError(t("cloneRepositoryDialog.folderPickerFailed")));
                    }}
                  />
                </div>
              )}
            </Field>

            <Field label={t("cloneRepositoryDialog.newFolderName")}>
              {(field) => (
                <Input
                  {...field}
                  aria-label={t("cloneRepositoryDialog.cloneFolderName")}
                  value={name}
                  disabled={busy}
                  placeholder={t("cloneRepositoryDialog.folderNamePlaceholder")}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameEdited(!!event.target.value);
                  }}
                />
              )}
            </Field>
            <Disclosure title={t("sparse.title")}>
              <Checkbox
                checked={sparse}
                disabled={busy}
                onChange={(event) => setSparse(event.target.checked)}
              >
                {t("sparse.clone")}
              </Checkbox>
              {sparse && (
                <Field label={t("sparse.directories")}>
                  {(field) => (
                    <Textarea
                      {...field}
                      value={directories}
                      disabled={busy}
                      onChange={(event) => setDirectories(event.target.value)}
                    />
                  )}
                </Field>
              )}
              <Checkbox
                checked={blobless}
                disabled={busy}
                onChange={(event) => setBlobless(event.target.checked)}
              >
                {t("sparse.blobless")}
              </Checkbox>
            </Disclosure>
            <Disclosure title={t("shallow.cloneHistory")}>
              <div className="space-y-2">
                <Field label={t("shallow.branch")}>
                  {(field) => (
                    <Input
                      {...field}
                      value={branch}
                      disabled={busy}
                      onChange={(event) => setBranch(event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t("shallow.depth")}>
                  {(field) => (
                    <Input
                      {...field}
                      type="number"
                      min={1}
                      max={2147483647}
                      value={depth}
                      disabled={busy || !!since}
                      onChange={(event) => setDepth(event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t("shallow.since")}>
                  {(field) => (
                    <Input
                      {...field}
                      type="date"
                      value={since}
                      disabled={busy || !!depth}
                      onChange={(event) => setSince(event.target.value)}
                    />
                  )}
                </Field>
              </div>
            </Disclosure>
          </section>
        </div>

        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
