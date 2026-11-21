import { t } from "@shared/i18n";
import { useEffect } from "react";
import { ArrowUpIcon as ArrowUp } from "../../components/ui/icons";
import { DialogActions, Button, Dialog } from "../../components/ui/index";
import { openSettings } from "../../stores/shell-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { HttpsAuthenticationDialog } from "./HttpsAuthenticationDialog";
import { TransferProgress } from "./TransportFields";
import { useDirectPush, type PushTagTarget } from "./hooks/useDirectPush";
import { ProviderIcon } from "../connections/ProviderIcon";

export function DirectPush({
  repositoryId,
  afterCommit = false,
  disabled = false,
  tag,
  onClose,
  onChanged,
}: {
  repositoryId: string;
  afterCommit?: boolean;
  disabled?: boolean;
  tag?: PushTagTarget;
  onClose?: () => void;
  onChanged?: (() => void) | undefined;
}) {
  const autoStart = afterCommit || !!tag;
  const {
    busy,
    preview,
    setPreview,
    error,
    showError,
    setShowError,
    setCredentials,
    needsAuth,
    setNeedsAuth,
    githubFailure,
    githubRemote,
    message,
    closeAuthentication,
    runPush,
    confirmLease,
  } = useDirectPush(repositoryId, autoStart, tag);

  const writing = useRepositoryStore((state) => state.writing);

  useEffect(() => {
    if (tag && message && !busy) {
      onChanged?.();
      onClose?.();
    }
  }, [tag, message, busy, onChanged, onClose]);

  const close = () => {
    setPreview(null);
    closeAuthentication();
    onClose?.();
  };

  return (
    <>
      {!autoStart && (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || writing || busy}
          busy={busy}
          feedback={error ? "error" : message ? "success" : "idle"}
          icon={<ArrowUp size={14} />}
          title={
            error ? t("directPush.pushFailedClickForDetails") : (message ?? t("directPush.push"))
          }
          onClick={() => (error ? setShowError(true) : void runPush("normal"))}
        >
          {t("directPush.push")}
        </Button>
      )}

      <span role="status" className="sr-only">
        {busy ? t("directPush.pushing") : (error ?? message)}
      </span>

      {error && !preview && needsAuth && (
        <HttpsAuthenticationDialog
          shortLabels
          title={t("directPush.hTtpsAuthentication")}
          description={t("directPush.enterYourGitUsernameAndAccessTokenToRetry")}
          submitLabel={t("directPush.retryPush")}
          error={error}
          busy={busy}
          onClose={close}
          onSubmit={(auth) => {
            setCredentials(auth);
            setNeedsAuth(false);
            void runPush("normal", auth);
          }}
        >
          {githubRemote && (
            <div className="space-y-2 border-t border-border-subtle pt-3">
              <p className="text-xs text-text-secondary">
                {githubFailure === "access"
                  ? t("directPush.gitHubAccessChoice")
                  : t("directPush.gitHubAuthenticationChoice")}
              </p>

              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                icon={<ProviderIcon provider="GitHub" />}
                onClick={() => {
                  close();
                  openSettings("integrations");
                }}
              >
                {t("directPush.useGitHubIntegration")}
              </Button>
            </div>
          )}
        </HttpsAuthenticationDialog>
      )}

      {error && !preview && !needsAuth && (showError || autoStart) && (
        <Dialog
          title={t("directPush.pushFailed")}
          onClose={close}
          footer={<Button onClick={close}>{t("common.close")}</Button>}
        >
          <p role="alert" className="text-sm text-git-deleted">
            {error}
          </p>
        </Dialog>
      )}

      {preview && (
        <Dialog
          title={t("directPush.forcePush")}
          description={t("directPush.thisPushReplacesRemoteHistoryForceWithLease")}
          onClose={close}
          busy={busy}
          footer={
            <DialogActions
              onClose={close}
              onConfirm={() => void confirmLease()}
              confirmLabel={t("directPush.forceWithLease")}
              busy={busy}
            />
          }
        >
          <p className="break-all text-sm">
            {t("directPush.destinationDescription", {
              source: preview.source,
              url: preview.url,
              destination: preview.destination,
            })}
          </p>

          <p className="mt-2 text-xs text-text-secondary">
            {t("directPush.localRemote", {
              value1: preview.localOid?.slice(0, 12) ?? "—",
              value2: preview.remoteOid?.slice(0, 12) ?? t("directPush.newRef"),
            })}
          </p>

          {error && (
            <p role="alert" className="mt-3 text-sm text-git-deleted">
              {error}
            </p>
          )}

          {busy && (
            <TransferProgress repositoryId={repositoryId} kindKey="operationTitles.pushBranch" />
          )}
        </Dialog>
      )}
    </>
  );
}
