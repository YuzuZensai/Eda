import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { useState } from "react";
import { Dialog, Field, Input, TextButton } from "../../components/ui/index";
import type { WorkflowState } from "@shared/workflows/workflow";

export function MailboxDialog({
  id,
  head,
  state,
  enabled,
  onClose,
}: {
  id: string;
  head: string;
  state: WorkflowState | null;
  enabled: boolean;
  onClose: () => void;
}) {
  const [tip, setTip] = useState(head);
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const run = async (action: "export" | "apply" | "continue" | "abort") => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      let result;
      if (action === "export")
        result = await window.eda.repository.exportPatch(
          { repositoryId: id, oid: tip },
          base ? { after: base } : {},
        );
      else if (action === "apply") result = await window.eda.repository.applyPatch(id, true);
      else if (state) result = await window.eda.repository.resumeMailbox(id, action, state.token);
      if (result && !result.ok) setNotice(errorMessage(result.error));
      else if (result?.ok && result.value !== false)
        setNotice(t(action === "export" ? "mailbox.saved" : "mailbox.applied"));
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("mailbox.preview")} busy={busy} onClose={onClose}>
      {state?.kind === "am" ? (
        <>
          <TextButton
            disabled={busy || !!state.conflicts.length}
            onClick={() => void run("continue")}
          >
            {t("mailbox.continue")}
          </TextButton>
          <TextButton disabled={busy} onClick={() => void run("abort")}>
            {t("mailbox.abort")}
          </TextButton>
        </>
      ) : (
        enabled && (
          <div className="space-y-3">
            <p>{t("mailbox.note")}</p>
            <Field label={t("mailbox.tip")}>
              {(field) => (
                <Input
                  {...field}
                  disabled={busy}
                  value={tip}
                  onChange={(e) => setTip(e.target.value)}
                />
              )}
            </Field>
            <Field label={t("mailbox.base")}>
              {(field) => (
                <Input
                  {...field}
                  disabled={busy}
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                />
              )}
            </Field>
            <TextButton disabled={busy || !tip} onClick={() => void run("export")}>
              {t("mailbox.export")}
            </TextButton>
            <TextButton disabled={busy || !!state} onClick={() => void run("apply")}>
              {t("mailbox.apply")}
            </TextButton>
          </div>
        )
      )}
      {notice && <p role="status">{notice}</p>}
    </Dialog>
  );
}
