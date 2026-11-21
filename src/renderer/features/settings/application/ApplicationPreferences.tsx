import { defaultDiffArgs, isDiffTool } from "@shared/integrations/merge-tool";
import { HTTPS_HELPERS } from "@shared/integrations/remotes";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { DetectedEditor } from "@shared/integrations/editor";
import { useEffect, useId, useState } from "react";
import { useAppStore } from "../../../stores/app-store";
import { ErrorDialog, Select, Checkbox, TextButton, Textarea } from "../../../components/ui/index";
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
  const profileId = useAppStore((state) => state.activeIdentity?.id);
  const [transferError, setTransferError] = useState("");
  const [transferring, setTransferring] = useState(false);
  const transfer = async (action: "import" | "export") => {
    if (transferring || (owner === "profile" && !profileId)) return;
    setTransferring(true);
    try {
      const result = await window.eda.settings.transferPreferences(
        owner === "profile" && profileId ? { kind: owner, profileId } : { kind: "application" },
        action,
      );
      if (!result.ok) setTransferError(errorMessage(result.error));
    } catch (error) {
      setTransferError(errorMessage(error));
    } finally {
      setTransferring(false);
    }
  };
  const toolbar = useScopedSetting("toolbarLabels", owner);
  const notices = useScopedSetting("updateNotices", owner);
  const helper = useScopedSetting("httpsHelper", owner);
  return (
    <div className="flex flex-col gap-5">
      {owner === "application" && <LanguageSettings />}
      <Checkbox
        checked={toolbar.resolved.value}
        disabled={toolbar.unavailable}
        onChange={(event) => void toolbar.set(event.target.checked)}
      >
        {t("settings.tools.toolbar")}
      </Checkbox>
      <Checkbox
        checked={notices.resolved.value}
        disabled={notices.unavailable}
        onChange={(event) => void notices.set(event.target.checked)}
      >
        {t("settings.tools.notices")}
      </Checkbox>
      {owner === "application" && (
        <details>
          <summary>{t("settings.tools.advanced")}</summary>
          <div className="space-y-3 py-2">
            {(["git", "ssh", "gpg"] as const).map((kind) => (
              <ApplicationPicker key={kind} owner={owner} kind={kind} />
            ))}
          </div>
        </details>
      )}
      <ApplicationPicker owner={owner} kind="browser" />
      <ApplicationPicker owner={owner} kind="editor" />
      <ApplicationPicker owner={owner} kind="terminal" />
      <ApplicationPicker owner={owner} kind="diff" />
      <DiffArguments owner={owner} />
      <label className="space-y-1 text-sm">
        <span>{t("settings.app.httpsHelper")}</span>
        <p className="text-xs text-text-secondary">{t("settings.app.httpsHelperHint")}</p>
        <Select
          value={helper.following ? "global" : helper.resolved.value}
          disabled={helper.unavailable}
          onValueChange={(value) => {
            if (value === "global") void helper.reset();
            else {
              const selected = HTTPS_HELPERS.find((item) => item === value);
              if (selected) void helper.set(selected);
            }
          }}
        >
          {owner === "profile" && <option value="global">{t("common.followGlobal")}</option>}
          {HTTPS_HELPERS.map((name) => (
            <option key={name} value={name}>
              {name === "none" ? t("common.none") : name}
            </option>
          ))}
        </Select>
      </label>
      <MergeToolSettings owner={owner} />
      {owner === "application" && <GraphicsSettings />}
      <fieldset disabled={transferring} className="space-y-1">
        <legend>{t("settings.portable.title")}</legend>
        <p className="text-xs text-text-secondary">{t("settings.portable.hint")}</p>
        {owner === "profile" && <ProfileRepositoryHints />}
        <div className="flex gap-2">
          <TextButton onClick={() => void transfer("export")}>
            {t("settings.portable.export")}
          </TextButton>
          <TextButton onClick={() => void transfer("import")}>
            {t("settings.portable.import")}
          </TextButton>
        </div>
      </fieldset>
      {transferError && (
        <ErrorDialog onDismiss={() => setTransferError("")}>{transferError}</ErrorDialog>
      )}
    </div>
  );
}

function DiffArguments({ owner }: { owner: "application" | "profile" }) {
  const program = useScopedSetting("diffExecutable", owner);
  const config = useScopedSetting("diffTool", owner);
  const executable = program.resolved.value;
  const saved = config.resolved.value;
  const args = saved?.executable === executable ? saved.args : defaultDiffArgs;
  const current = args.join("\n");
  const [draft, setDraft] = useState(current);
  useEffect(() => {
    setDraft(current);
  }, [current, executable, owner]);
  if (!executable) return null;
  const selection = { executable, args: draft.split(/\r?\n/) };
  return (
    <details>
      <summary>{t("externalDiff.arguments")}</summary>
      <label className="text-xs text-text-secondary">
        {t("externalDiff.argumentsHint", { before: defaultDiffArgs[0], after: defaultDiffArgs[1] })}
        <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <TextButton
        disabled={config.unavailable || draft === current || !isDiffTool(selection)}
        onClick={() => void config.set(selection)}
      >
        {t("common.save")}
      </TextButton>
      {saved && !config.following && (
        <TextButton onClick={() => void config.reset()}>{t("common.reset")}</TextButton>
      )}
    </details>
  );
}

function ProfileRepositoryHints() {
  const hints = useScopedSetting("repositoryHints", "profile");
  if (!hints.resolved.value.length) return null;
  return (
    <details>
      <summary>{t("settings.portable.locations")}</summary>
      <p className="text-xs text-text-secondary">{t("settings.portable.reconnect")}</p>
      <ul className="selectable mono max-h-48 overflow-auto text-xs">
        {hints.resolved.value.map((path) => (
          <li className="break-all" key={path}>
            {path}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ApplicationPicker({
  owner,
  kind,
}: {
  owner: "application" | "profile";
  kind: "editor" | "browser" | "terminal" | "diff" | "git" | "ssh" | "gpg";
}) {
  const isEditor = kind === "editor";
  const setting = useScopedSetting(`${kind}Executable`, owner);
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
        const result = await (kind === "browser"
          ? window.eda.app.chooseBrowser()
          : window.eda.app.chooseEditor(kind));
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
        {t(
          (
            {
              editor: "settings.app.editor",
              browser: "settings.browser.label",
              terminal: "worktrees.terminal",
              diff: "externalDiff.label",
              git: "settings.tools.git",
              ssh: "settings.tools.ssh",
              gpg: "settings.tools.gpg",
            } as const
          )[kind],
        )}
      </label>
      <p className="text-xs text-text-secondary">
        {t(
          (
            {
              editor: "settings.app.editorHint",
              browser: "settings.browser.description",
              terminal: "worktrees.terminalHint",
              diff: "externalDiff.hint",
              git: "settings.tools.gitHint",
              ssh: "settings.tools.restart",
              gpg: "settings.tools.restart",
            } as const
          )[kind],
        )}
      </p>
      <Select
        id={id}
        value={setting.following ? "global" : selected || "none"}
        onValueChange={(value) => void choose(value)}
        surface="base"
      >
        {owner === "profile" && <option value="global">{t("common.followGlobal")}</option>}
        <option value="none">
          {t(kind === "browser" ? "settings.browser.system" : "common.none")}
        </option>
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
