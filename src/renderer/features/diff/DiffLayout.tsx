import { t } from "@shared/i18n";
import type { DiffMode, DiffDisplayOptions } from "@shared/repository/repository-read";
import { useEffect, useState } from "react";
import { Columns2Icon, Rows3Icon } from "../../components/ui/icons";
import { Checkbox, IconButton, Select } from "../../components/ui/index";
import { usePreferencesStore } from "../../stores/preferences-store";

export function useDiffLayout(profileId: string | undefined, repositoryId: string | null) {
  const mode = usePreferencesStore((state) => state.values.diffMode.value);

  useEffect(() => {
    if (profileId && repositoryId)
      void usePreferencesStore.getState().load({ profileId, repositoryId });
  }, [profileId, repositoryId]);

  const setMode = (value: DiffMode) => {
    if (profileId && repositoryId)
      void usePreferencesStore
        .getState()
        .set("diffMode", { kind: "repository", profileId, repositoryId }, value);
  };

  return { mode, setMode };
}

export function DiffLayoutControls({
  mode,
  setMode,
}: {
  mode: DiffMode;
  setMode: (mode: DiffMode) => void;
}) {
  return (
    <div
      role="group"
      data-tour="diff-layout"
      aria-label={t("diffViewer.diffLayout")}
      className="flex shrink-0 gap-0.5"
    >
      <IconButton
        size="xs"
        aria-label={t("diffViewer.unified")}
        title={t("diffViewer.unified")}
        aria-pressed={mode === "unified"}
        className={mode === "unified" ? "bg-accent-muted text-accent-text" : undefined}
        onClick={() => setMode("unified")}
        icon={<Rows3Icon size={14} aria-hidden="true" />}
      />

      <IconButton
        size="xs"
        aria-label={t("diffViewer.sideBySide")}
        title={t("diffViewer.sideBySide")}
        aria-pressed={mode === "split"}
        className={mode === "split" ? "bg-accent-muted text-accent-text" : undefined}
        onClick={() => setMode("split")}
        icon={<Columns2Icon size={14} aria-hidden="true" />}
      />
    </div>
  );
}

export function useDiffDisplay() {
  const [options, setOptions] = useState<DiffDisplayOptions>({});
  const [wrap, setWrap] = useState(false);
  return { options, setOptions, wrap, setWrap };
}

export function DiffDisplayControls({
  options,
  setOptions,
  wrap,
  setWrap,
}: ReturnType<typeof useDiffDisplay>) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-1">
      <Select
        compact
        aria-label={t("diff.options.context")}
        value={options.context ?? "hunks"}
        onValueChange={(context) =>
          setOptions({
            ...(options.ignoreWhitespace && { ignoreWhitespace: true }),
            ...((context === "full" || context === "expanded") && { context }),
          })
        }
      >
        <option value="hunks">{t("diff.options.hunks")}</option>
        <option value="expanded">{t("diff.options.expanded")}</option>
        <option value="full">{t("diff.options.full")}</option>
      </Select>
      <Checkbox
        checked={!!options.ignoreWhitespace}
        onChange={(event) => setOptions({ ...options, ignoreWhitespace: event.target.checked })}
      >
        {t("diff.options.whitespace")}
      </Checkbox>
      <Checkbox checked={wrap} onChange={(event) => setWrap(event.target.checked)}>
        {t("settings.componentPreviews.wrapLongLines")}
      </Checkbox>
    </div>
  );
}
