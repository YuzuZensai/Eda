import { t } from "@shared/i18n";
import { useTrustPrompt } from "../../components/ui/overlays/useTrustPrompt";
import { DialogActions, DefinitionList, Dialog } from "../../components/ui/index";

export function SshHostTrustDialog() {
  const { request, busy, respond, feedback } = useTrustPrompt(
    window.eda.ssh.pendingHostTrust,
    window.eda.events.onSshHostTrustChanged,
    window.eda.ssh.respondHostTrust,
    t("sshHostTrustDialog.couldNotSendYourDecisionTryAgain"),
  );
  if (!request) return null;

  return (
    <Dialog
      key={request.id}
      title={t("sshHostTrustDialog.trustSshHost")}
      description={t("sshHostTrustDialog.thisServerIsNotTrustedYetCompareIts")}
      busy={busy}
      onClose={() => void respond(false)}
      footer={
        <DialogActions
          autoFocusClose
          closeVariant="secondary"
          busy={busy}
          onClose={() => void respond(false)}
          onConfirm={() => void respond(true)}
          confirmLabel={t("sshHostTrustDialog.trustAndContinue")}
        />
      }
    >
      <DefinitionList
        items={[
          { label: t("sshHostTrustDialog.host"), value: request.host },
          { label: t("sshHostTrustDialog.keyType"), value: request.algorithm },
          {
            label: t("sshHostTrustDialog.sHa256Fingerprint"),
            value: <code className="selectable text-xs">{request.fingerprint}</code>,
          },
        ]}
      />
      <p className="mt-3 text-xs leading-relaxed text-text-secondary">
        {t("sshHostTrustDialog.trustingSavesThisHostKeyAndContinuesThe")}
      </p>
      {feedback && (
        <p role="alert" className="mt-3 text-xs text-git-deleted">
          {feedback}
        </p>
      )}
    </Dialog>
  );
}
