import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { DetectedEditor } from "@shared/integrations/editor";
import { useEffect, useId, useState } from "react";
import { ErrorDialog, Select } from "../../../components/ui/index";
import { usePreferencesStore } from "../../../stores/preferences-store";
import { MergeToolSettings } from "../git/MergeToolSettings";
import { useScopedSetting } from "../hooks/useScopedSetting";
import { GraphicsSettings } from "./GraphicsSettings";
import { LanguageSettings } from "./LanguageSettings";

export function ApplicationPreferences({
  owner = "application",
}: {
  owner?: "application" | "profile";
}) {
  return (
    <div className="flex flex-col gap-5">
      {owner === "application" && <LanguageSettings />}
      <ApplicationPicker owner={owner} kind="browser" />
      <ApplicationPicker owner={owner} kind="editor" />
      <MergeToolSettings owner={owner} />
      {owner === "application" && <GraphicsSettings />}
    </div>
  );
}

function ApplicationPicker({
  owner,
  kind,
}: {
  owner: "application" | "profile";
  kind: "editor" | "browser";
}) {
  const isEditor = kind === "editor";
  const setting = useScopedSetting(isEditor ? "editorExecutable" : "browserExecutable", owner);
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [editors, setEditors] = useState<DetectedEditor[]>([]);
  const [detecting, setDetecting] = useState(isEditor);
  const [choosing, setChoosing] = useState(false);
  const saving = usePreferencesStore((state) => state.saving);
  const selected = setting.resolved.value;

  useEffect(() => {
    if (!isEditor) return;
    let cancelled = false;

    void window.eda.app
      .detectEditors()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setEditors(result.value);
        else setError(errorMessage(result.error));
      })
      .catch(() => {
        if (!cancelled) setError(t("settings.app.detectFailed"));
      })
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isEditor]);

  const choose = async (value: string) => {
    setError(null);
    setChoosing(true);

    try {
      if (value === "global") {
        await setting.reset();
      } else if (value === "none") {
        await setting.set("");
      } else if (value === "manual") {
        const result = await (isEditor
          ? window.eda.app.chooseEditor()
          : window.eda.app.chooseBrowser());
        if (!result.ok) setError(errorMessage(result.error));
        else if (result.value) await setting.set(result.value);
      } else {
        await setting.set(value);
      }
    } catch {
      setError(t("settings.app.selectFailed"));
    } finally {
      setChoosing(false);
    }
  };

  return (
    <fieldset
      disabled={saving || choosing || setting.unavailable}
      aria-busy={saving || choosing || setting.reading}
      className="space-y-2"
    >
      <label htmlFor={id} className="text-sm font-medium">
        {t(isEditor ? "settings.app.editor" : "settings.browser.label")}
      </label>
      <p className="text-xs text-text-secondary">
        {t(isEditor ? "settings.app.editorHint" : "settings.browser.description")}
      </p>
      <Select
        id={id}
        value={setting.following ? "global" : selected || "none"}
        onValueChange={(value) => void choose(value)}
        surface="base"
      >
        {owner === "profile" && <option value="global">{t("common.followGlobal")}</option>}
        <option value="none">{t(isEditor ? "common.none" : "settings.browser.system")}</option>
        {editors.map((editor) => (
          <option key={editor.executable} value={editor.executable}>
            {editor.name}
          </option>
        ))}
        {selected && !editors.some((editor) => editor.executable === selected) && (
          <option value={selected}>
            {isEditor
              ? t("settings.app.customEditor", {
                  value1: selected.split(/[\\/]/).pop(),
                })
              : selected.split(/[\\/]/).pop()}
          </option>
        )}
        <option value="manual">{t("settings.app.choose")}</option>
      </Select>
      {isEditor &&
        (detecting ? (
          <p role="status" className="text-xs text-text-tertiary">
            {t("settings.app.detecting")}
          </p>
        ) : (
          editors.length === 0 && (
            <p className="text-xs text-text-tertiary">{t("settings.app.noEditors")}</p>
          )
        ))}
      {selected && <p className="break-all text-xs text-text-tertiary">{selected}</p>}
      <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
    </fieldset>
  );
}
