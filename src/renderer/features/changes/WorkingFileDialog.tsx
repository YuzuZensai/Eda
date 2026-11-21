import { useState } from "react";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { Dialog, Field, Input, TextButton } from "../../components/ui/index";

export function WorkingFileDialog({
  id,
  initialPath,
  onClose,
}: {
  id: string;
  initialPath: string;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const run = async (action: "create" | "delete" | "reveal" | "editor") => {
    if (action === "delete" && !confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const result = await window.eda.repository.workingFile(id, path, action);
      if (!result.ok) setNotice(errorMessage(result.error));
      else if (action === "create" || action === "delete") setNotice(t("workingFile.done"));
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <Dialog title={t("workingFile.title")} busy={busy} onClose={onClose}>
      <Field label={t("workingFile.path")}>
        {(field) => (
          <Input
            {...field}
            value={path}
            disabled={busy}
            onChange={(e) => {
              setConfirm(false);
              setNotice("");
              setPath(e.target.value);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-3">
        {(["create", "editor", "reveal", "delete"] as const).map((action) => (
          <TextButton key={action} disabled={busy || !path} onClick={() => void run(action)}>
            {action === "delete" && confirm
              ? t("workingFile.confirm", { path })
              : t(action === "editor" ? "workingFile.edit" : `workingFile.${action}`)}
          </TextButton>
        ))}
      </div>
      {notice && <p role="status">{notice}</p>}
    </Dialog>
  );
}
