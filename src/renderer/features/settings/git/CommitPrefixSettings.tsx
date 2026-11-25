import { t } from "@shared/i18n";
import { RotateCcwIcon as RotateCcw } from "../../../components/ui/icons";
import { defaultCommitPrefixes, parseCommitPrefixes } from "@shared/preferences/commit-prefix";
import { useEffect, useId, useState } from "react";
import { SETTING_DEFINITIONS } from "@shared/preferences/settings";
import { preferenceSource } from "../../../stores/preferences-store";
import { useScopedSetting } from "../hooks/useScopedSetting";
import { Button, Checkbox, Textarea, IconButton, Dialog } from "../../../components/ui/index";

export function CommitPrefixSettings({ owner }: { owner: "application" | "profile" }) {
  const inputId = useId();
  const enabled = useScopedSetting("conventionalCommitsEnabled", owner);
  const prefixes = useScopedSetting("commitPrefixes", owner);
  const savedText = prefixes.resolved.value.join("\n");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [text, setText] = useState(savedText);

  useEffect(() => setText(savedText), [savedText]);

  const parsed = parseCommitPrefixes(text);
  const valid = SETTING_DEFINITIONS.commitPrefixes.validate(parsed);
  const changed = JSON.stringify(parsed) !== JSON.stringify(prefixes.resolved.value);

  return (
    <fieldset
      disabled={enabled.unavailable || prefixes.unavailable}
      aria-busy={enabled.reading || prefixes.reading}
      className="min-w-0 space-y-3 border-b border-border-subtle pb-4"
    >
      <h2 className="text-sm font-medium">
        {t("settings.commitPrefixSettings.conventionalCommits")}
      </h2>

      <Checkbox
        checked={enabled.resolved.value}
        onChange={(event) => void enabled.set(event.target.checked)}
      >
        {t("settings.commitPrefixSettings.showCommitPrefixPicker")}
      </Checkbox>

      <p className="text-xs text-text-secondary">
        {t("settings.commitPrefixSettings.selectingAPrefixAddsItToTheSaved", {
          value1: preferenceSource(enabled.resolved),
        })}
      </p>

      {owner === "profile" && !enabled.following && (
        <Button size="sm" variant="secondary" onClick={() => void enabled.reset()}>
          {t("common.followGlobal")}
        </Button>
      )}

      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="text-sm">
          {t("settings.commitPrefixSettings.commitPrefixes")}
        </label>

        <IconButton
          icon={<RotateCcw size={14} />}
          aria-label={t("settings.commitPrefixSettings.resetCommitPrefixes")}
          title={t("settings.commitPrefixSettings.resetCommitPrefixes")}
          onClick={() => setResetOpen(true)}
        />
      </div>

      <div>
        <Textarea
          id={inputId}
          aria-label={t("settings.commitPrefixSettings.commitPrefixes")}
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          invalid={!valid}
        />
      </div>

      <p className="text-xs text-text-secondary">
        {t("settings.commitPrefixSettings.enterOneTypePerLineOrSeparateWith", {
          value1: preferenceSource(prefixes.resolved),
        })}
      </p>

      <div className="flex gap-2">
        <Button size="sm" disabled={!valid || !changed} onClick={() => void prefixes.set(parsed)}>
          {t("settings.commitPrefixSettings.savePrefixes")}
        </Button>

        {owner === "profile" && !prefixes.following && (
          <Button size="sm" variant="secondary" onClick={() => void prefixes.reset()}>
            {t("settings.commitPrefixSettings.followGlobalPrefixes")}
          </Button>
        )}
      </div>

      {resetOpen && (
        <Dialog
          title={t("settings.commitPrefixSettings.resetCommitPrefixes")}
          description={t(
            "settings.commitPrefixSettings.restoreTheDefaultPrefixesWithOrWithoutEmojis",
          )}
          busy={resetting}
          onClose={() => setResetOpen(false)}
        >
          <div className="flex flex-wrap gap-2">
            {[false, true].map((emojis) => (
              <Button
                key={String(emojis)}
                disabled={resetting}
                onClick={async () => {
                  setResetting(true);

                  try {
                    if (await prefixes.set(defaultCommitPrefixes(emojis))) setResetOpen(false);
                  } finally {
                    setResetting(false);
                  }
                }}
              >
                {emojis
                  ? t("settings.commitPrefixSettings.withEmojis")
                  : t("settings.commitPrefixSettings.withoutEmojis")}
              </Button>
            ))}

            <Button variant="ghost" disabled={resetting} onClick={() => setResetOpen(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </Dialog>
      )}
    </fieldset>
  );
}
