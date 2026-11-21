import { useState } from "react";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { submoduleUpdateModes, type SubmoduleListing } from "@shared/repository/repository-read";
import { isOneOf } from "@shared/validation";
import type { SubmoduleAction } from "@shared/repository/repository-write";
import { Checkbox, Disclosure, Field, Input, Select, TextButton } from "../../components/ui/index";

export function SubmoduleTools({
  id,
  listing,
  onChange,
}: {
  id: string;
  listing: SubmoduleListing | null | undefined;
  onChange: () => void;
}) {
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [selectedMode, setMode] = useState<SubmoduleListing["defaultMode"]>();
  const mode = selectedMode ?? listing?.defaultMode ?? "checkout";
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const run = async (action: SubmoduleAction) => {
    if (busy) return;
    if (action.kind === "remove" && !confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setConfirm(false);
    setNotice("");
    try {
      const result = await window.eda.repository.changeSubmodule(id, action);
      setNotice(result.ok ? t("submodules.done") : errorMessage(result.error));
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
      onChange();
    }
  };
  return (
    <Disclosure title={t("submodules.manage")}>
      <div className="space-y-2">
        <Field label={t("submodules.path")}>
          {(field) => (
            <Input
              {...field}
              value={path}
              disabled={busy}
              onChange={(e) => {
                setPath(e.target.value);
                setConfirm(false);
              }}
            />
          )}
        </Field>
        <Field label={t("submodules.url")}>
          {(field) => (
            <Input
              {...field}
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>
        <TextButton
          disabled={busy || !path || !url}
          onClick={() => void run({ kind: "add", path, url })}
        >
          {t("submodules.add")}
        </TextButton>
        <Field label={t("submodules.mode")}>
          {(field) => (
            <Select
              {...field}
              value={mode}
              disabled={busy}
              onValueChange={(v) => {
                if (isOneOf(v, submoduleUpdateModes)) setMode(v);
              }}
            >
              {submoduleUpdateModes.map((item) => (
                <option key={item} value={item}>
                  {t(`submodules.${item}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Checkbox
          checked={recursive}
          disabled={busy}
          onChange={(e) => setRecursive(e.target.checked)}
        >
          {t("submodules.recursive")}
        </Checkbox>
        <div className="flex flex-wrap gap-2">
          {(["init", "update", "sync"] as const).map((kind) => (
            <TextButton
              key={kind}
              disabled={busy || !path}
              onClick={() => void run({ kind, path, mode, recursive })}
            >
              {t(`submodules.${kind}`)}
            </TextButton>
          ))}
          <TextButton disabled={busy || !path} onClick={() => void run({ kind: "remove", path })}>
            {confirm ? t("submodules.confirm", { path }) : t("submodules.remove")}
          </TextButton>
        </div>
        <Checkbox
          checked={listing?.automatic ?? false}
          disabled={busy || !listing}
          onChange={(e) => void run({ kind: "automatic", enabled: e.target.checked })}
        >
          {t("submodules.autoOn")}
        </Checkbox>
        {notice && <p role="status">{notice}</p>}
      </div>
    </Disclosure>
  );
}
