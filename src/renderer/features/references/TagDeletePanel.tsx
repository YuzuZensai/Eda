import { useReferenceAction } from "./hooks/useReferenceAction";
import { errorAction, errorMessage, GitError, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  preferredRemote,
  type RemoteSummary,
  type TransportCredentials,
} from "@shared/integrations/remotes";
import { useEffect, useRef, useState } from "react";
import {
  captureRepositoryCommand,
  repositoryCommandDispatcher,
  repositoryCommandReason,
} from "../../commands/repository-commands";
import { ActionIndicator, Button, NoticeBanner, Radio } from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";
import { Select } from "../../components/ui/forms/FormControls";
import { CredentialFields } from "../sync/TransportFields";

export function TagDeletePanel({
  repositoryId,
  name,
  initialRemote,
  onClose,
  onChanged,
  onBusyChange,
  remoteOnly = false,
}: {
  repositoryId: string;
  name: string;
  initialRemote?: string;
  onClose: () => void;
  onChanged?: (() => void) | undefined;
  onBusyChange: (busy: boolean) => void;
  remoteOnly?: boolean;
}) {
  const [context] = useState(() => captureRepositoryCommand(repositoryId));
  const [remotes, setRemotes] = useState<RemoteSummary[]>([]);
  const [remote, setRemote] = useState("");
  const [local, setLocal] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [scope, setScope] = useState<"local" | "remote" | "both">(remoteOnly ? "remote" : "local");
  const [remoteDeleted, setRemoteDeleted] = useState(false);
  const [presentRemotely, setPresentRemotely] = useState<boolean | null>(null);
  const [checkingRemote, setCheckingRemote] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const lookupRevision = useRef(0);
  const [auth, setAuth] = useState<TransportCredentials>({ username: "", password: "" });
  const { busy, assertContext, running, error, setError, run, refresh } = useReferenceAction(
    context,
    { onBusyChange },
  );
  useRepositoryStore((state) => state.writing);
  const unavailable = repositoryCommandReason(context);

  const requireResult = <T,>(result: Result<T>): T => {
    if (!result.ok) {
      if (result.error.kind === "auth-failed") setNeedsAuth(true);
      throw new GitError(result.error);
    }

    return result.value;
  };

  const credentials = auth.username || auth.password ? auth : undefined;

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      window.eda.remotes.inspect(repositoryId),
      window.eda.repository.listTags(repositoryId),
    ])
      .then(([stateResult, tagsResult]) => {
        if (cancelled) return;
        const state = requireResult(stateResult);
        const tags = requireResult(tagsResult);
        const exists = tags.some((tag) => tag.name === name);
        setLocal(exists);
        if (!exists) setScope("remote");
        setRemotes(state.remotes);

        setRemote(
          state.remotes.some((item) => item.name === initialRemote)
            ? initialRemote!
            : (preferredRemote(state)?.name ?? ""),
        );

        setLoaded(true);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorMessage(failure));
      });

    return () => {
      cancelled = true;
    };
  }, [repositoryId, name, initialRemote]);

  const inspectRemoteTag = async () => {
    const revision = ++lookupRevision.current;
    setPresentRemotely(null);
    setLookupError(null);
    setCheckingRemote(!!remote);
    if (!remote) return;

    try {
      const result = await window.eda.remotes.listTags({
        repositoryId,
        remote,
        ...(credentials ? { credentials } : {}),
      });

      if (revision !== lookupRevision.current) return;
      const tags = requireResult(result);
      const present = tags.some((tag) => tag.name === name);
      setPresentRemotely(present);
      if (!present && local) setScope("local");
      setNeedsAuth(false);
    } catch (failure) {
      if (revision === lookupRevision.current)
        setLookupError([errorMessage(failure), errorAction(failure)].filter(Boolean).join(" "));
    } finally {
      if (revision === lookupRevision.current) setCheckingRemote(false);
    }
  };

  useEffect(() => {
    void inspectRemoteTag();

    return () => {
      lookupRevision.current++;
    };
  }, [repositoryId, remote]);

  const includesLocal = scope !== "remote";
  const includesRemote = scope !== "local";

  const choices = (
    [
      ["local", t("referenceMenu.localOnly"), local],
      ["remote", t("referenceMenu.remoteOnly"), presentRemotely === true && !remoteDeleted],
      [
        "both",
        t("referenceMenu.localAndRemote"),
        local && presentRemotely === true && !remoteDeleted,
      ],
    ] as const
  ).filter(([, , available]) => available);

  const loading = (!loaded || checkingRemote) && !error && !lookupError;

  const close = () => {
    if (!running.current) onClose();
  };

  return (
    <div className="space-y-3 p-2 text-xs">
      {loaded && remotes.length === 0 && (
        <p>{t("directPush.noRemoteIsConfiguredAddOneInSettingsRepoThenRetry")}</p>
      )}

      {remotes.length > 1 && (
        <label className="block space-y-1">
          {t("remotesDialog.remote")}

          <Select
            compact
            className="w-full"
            aria-label={t("remotesDialog.remote")}
            value={remote}
            disabled={busy || remoteDeleted}
            onValueChange={(value) => {
              setRemote(value);
              setScope(local ? "local" : "remote");
              setAuth({ username: "", password: "" });
              setNeedsAuth(false);
              setError(null);
            }}
          >
            {remotes.map((item) => (
              <option key={item.name}>{item.name}</option>
            ))}
          </Select>
        </label>
      )}

      {(choices.length > 0 || loading) && (
        <fieldset className="space-y-2" disabled={busy || !loaded}>
          <legend className="flex min-h-4 items-center gap-2 font-medium">
            {t("referenceMenu.deleteTagFrom")}

            {loading && (
              <span
                role="status"
                aria-label={t("referenceMenu.loadingTagTargets")}
                className="inline-flex text-text-tertiary"
              >
                <ActionIndicator state="pending" />
              </span>
            )}
          </legend>

          {choices.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <Radio
                name="delete-tag-scope"
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
              />

              {label}
            </label>
          ))}
        </fieldset>
      )}

      {local && <p>{t("referenceMenu.local", { name })}</p>}
      {presentRemotely && !remoteDeleted && (
        <p className="break-all">{t("referenceMenu.remote", { name: remote, branch: name })}</p>
      )}
      {includesRemote && presentRemotely && !remoteDeleted && (
        <p>{t("referenceMenu.tagRemoteWarning")}</p>
      )}
      {loaded && !local && presentRemotely === false && (
        <p role="status">{t("referenceMenu.tagNoLongerExists")}</p>
      )}

      {remoteDeleted && (
        <p role="status">
          {t("referenceMenu.remoteTagDeleted", {
            value1: includesLocal
              ? t("referenceMenu.localDeletionHasNotCompletedRetryToDeleteItLocally")
              : "",
          })}
        </p>
      )}

      {needsAuth && !remoteDeleted && (
        <CredentialFields
          value={auth}
          onChange={setAuth}
          disabled={busy}
          shortLabels
          usernameLabel={t("referenceMenu.hTtpsUsername")}
        />
      )}

      <div className="flex gap-2">
        <Button size="sm" autoFocus disabled={busy} onClick={close}>
          {t("common.cancel")}
        </Button>

        {choices.some(([value]) => value === scope) && (
          <Button
            size="sm"
            variant="danger"
            busy={busy}
            disabled={
              !loaded ||
              !!unavailable ||
              (includesLocal && !local) ||
              (includesRemote && !presentRemotely && !remoteDeleted) ||
              (needsAuth &&
                includesRemote &&
                !remoteDeleted &&
                (!auth.username.trim() || !auth.password))
            }
            onClick={() =>
              void run(async () => {
                try {
                  if (includesRemote && !remoteDeleted) {
                    const preview = requireResult(
                      await window.eda.remotes.preparePush({
                        repositoryId,
                        remote,
                        branch: name,
                        destination: name,
                        refKind: "tag",
                        mode: "delete",
                        setUpstream: false,
                        ...(credentials ? { credentials } : {}),
                      }),
                    );

                    assertContext();

                    requireResult(
                      await window.eda.remotes.push(repositoryId, preview.token, credentials),
                    );

                    setRemoteDeleted(true);
                    setPresentRemotely(false);
                    if (includesLocal) setScope("local");
                    onChanged?.();
                  }

                  if (includesLocal) {
                    assertContext();

                    requireResult(
                      await repositoryCommandDispatcher(context)("deleteTag", {
                        repositoryId,
                        name,
                      }),
                    );

                    onChanged?.();
                  }

                  onClose();
                } finally {
                  await refresh();
                }
              })
            }
          >
            {t(
              scope === "both"
                ? "referenceMenu.deleteBoth"
                : scope === "local"
                  ? "referenceMenu.deleteLocal"
                  : "referenceMenu.deleteRemote",
            )}
          </Button>
        )}
      </div>

      {unavailable && <p>{unavailable}</p>}

      {lookupError && (
        <NoticeBanner
          tone="error"
          className="p-2"
          action={
            <Button
              size="sm"
              disabled={busy || checkingRemote}
              onClick={() => void inspectRemoteTag()}
            >
              {t("common.retry")}
            </Button>
          }
        >
          {lookupError}
        </NoticeBanner>
      )}

      {error && (
        <NoticeBanner tone="error" className="p-2">
          {error}
        </NoticeBanner>
      )}
    </div>
  );
}
