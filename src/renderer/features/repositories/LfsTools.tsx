import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { LfsAction } from "@shared/integrations/remotes";
import { useState } from "react";
import { Disclosure, Field, Input, TextButton } from "../../components/ui/index";

import { TransferProgress } from "../sync/TransportFields";

export function LfsTools({ id }: { id: string }) {
  const [pattern, setPattern] = useState("");
  const [remote, setRemote] = useState("origin");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [prune, setPrune] = useState(false);
  const [output, setOutput] = useState("");
  const run = async (action: LfsAction) => {
    if (busy) return;
    setBusy(true);
    setOutput("");
    setPrune(false);
    try {
      const result = await window.eda.repository.lfs(id, action);
      setOutput(result.ok ? result.value.trim() || t("lfs.success") : errorMessage(result.error));
      if (result.ok && action.kind === "previewPrune") setPrune(true);
    } catch (error) {
      setOutput(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const button = (action: LfsAction, disabled = false) => (
    <TextButton key={action.kind} disabled={busy || disabled} onClick={() => void run(action)}>
      {t(`lfs.${action.kind}`)}
    </TextButton>
  );
  return (
    <Disclosure title={t("lfs.title")}>
      <div className="space-y-2">
        {button({ kind: "install" })}
        <Field label={t("lfs.pattern")}>
          {(field) => (
            <Input {...field} value={pattern} onChange={(e) => setPattern(e.target.value)} />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          {button({ kind: "track", pattern }, !pattern)}
          {button({ kind: "untrack", pattern }, !pattern)}
        </div>
        <Field label={t("lfs.remote")}>
          {(field) => (
            <Input {...field} value={remote} onChange={(e) => setRemote(e.target.value)} />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          {(["fetch", "pull", "push", "locks"] as const).map((kind) =>
            button({ kind, remote }, !remote),
          )}
        </div>
        <Field label={t("lfs.path")}>
          {(field) => <Input {...field} value={path} onChange={(e) => setPath(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap gap-2">
          {button({ kind: "lock", remote, path }, !remote || !path)}
          {button({ kind: "unlock", remote, path }, !remote || !path)}
        </div>
        {button({ kind: "previewPrune" })}
        {busy && <TransferProgress repositoryId={id} kindKey="lfs.title" />}
        {output && (
          <pre className="selectable whitespace-pre-wrap" role="status">
            {output}
          </pre>
        )}
        {prune && button({ kind: "prune" })}
      </div>
    </Disclosure>
  );
}
