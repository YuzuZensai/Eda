import type { RepositoryTrustRequest } from "@shared/repository/repository";
import { t } from "@shared/i18n";
import { ShieldOffIcon } from "../../components/ui/icons";
import { DialogActions, Dialog, Disclosure } from "../../components/ui/index";
import { useTrustPrompt } from "../../components/ui/overlays/useTrustPrompt";

export function RepositoryTrustDialog() {
  const { request, busy, respond, feedback } = useTrustPrompt(
    window.eda.repository.pendingTrust,
    window.eda.events.onRepositoryTrustChanged,
    window.eda.repository.respondTrust,
    t("main.repositoryTrust.couldNotSendDecision"),
  );
  if (!request) return null;

  return (
    <RepositoryTrustPrompt request={request} busy={busy} respond={respond} feedback={feedback} />
  );
}

export function RepositoryTrustPrompt({
  request,
  busy = false,
  respond,
  feedback,
}: {
  request: RepositoryTrustRequest;
  busy?: boolean;
  respond: (trust: boolean) => void;
  feedback?: string | null | undefined;
}) {
  const name = request.path.split(/[\\/]/).filter(Boolean).at(-1) ?? request.path;

  return (
    <Dialog
      key={request.id}
      title={t("main.repositoryTrust.title")}
      description={t("main.repositoryTrust.message")}
      busy={busy}
      onClose={() => void respond(false)}
      footer={
        <DialogActions
          autoFocusClose
          closeVariant="secondary"
          busy={busy}
          closeLabel={t("main.repositoryTrust.keepDisabled")}
          onClose={() => void respond(false)}
          onConfirm={() => void respond(true)}
          confirmLabel={t("main.repositoryTrust.allow")}
        />
      }
    >
      <div className="flex min-w-0 items-center gap-3 rounded-md border border-border-subtle bg-bg-surface p-3">
        <ShieldOffIcon size={20} className="shrink-0 text-text-secondary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{name}</p>
          <p title={request.path} className="selectable mt-0.5 truncate text-xs text-text-tertiary">
            {request.path}
          </p>
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-text-secondary">
        {t(
          request.reasons?.length === 0
            ? "main.repositoryTrust.noFeaturesDetail"
            : "main.repositoryTrust.detail",
        )}
      </p>

      {!!request.reasons?.length && (
        <Disclosure
          title={t("main.repositoryTrust.detectedFeatures", { count: request.reasons.length })}
          className="mt-3 text-xs"
        >
          <ul className="selectable mt-2 max-h-40 overflow-y-auto rounded-md border border-border-subtle bg-bg-surface p-3 font-mono text-xs leading-6">
            {request.reasons.map((reason) => (
              <li key={reason} className="break-all">
                {reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-text-tertiary">
            {t("main.repositoryTrust.restrictedOperations")}
          </p>
        </Disclosure>
      )}

      {feedback && (
        <p role="alert" className="mt-3 text-xs text-git-deleted">
          {feedback}
        </p>
      )}
    </Dialog>
  );
}
