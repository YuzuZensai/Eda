import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { UI_ZOOM_PRESETS } from "@shared/preferences/settings";
import { useEffect, useId } from "react";
import { afterViewTransition } from "../../../components/layout/hooks/useViewTransition";
import { BackgroundSettings } from "./BackgroundSettings";
import { useScopedSetting } from "../hooks/useScopedSetting";
import { Checkbox, Select } from "../../../components/ui/index";
import { useAppStore } from "../../../stores/app-store";
import { previewMotion, usePreferencesStore } from "../../../stores/preferences-store";

let previewGeneration = 0;

function setGlobalPreview(enabled: boolean) {
  const generation = ++previewGeneration;
  afterViewTransition(async () => {
    if (generation !== previewGeneration) return;
    try {
      const result = await window.eda.settings.previewGlobalAppearance(enabled);
      if (!result.ok && generation === previewGeneration)
        usePreferencesStore.setState({ error: result.error });
    } catch {
      if (generation !== previewGeneration) return;
      usePreferencesStore.setState({
        error: new GitError({
          kind: "unknown",
          operation: t("operations.previewAppearance"),
          message: errorText("settings.appearanceControls.appearancePreviewCouldNotBeUpdated"),
        }).toData(),
      });
    }
  });
}

export function AppearanceControls({
  owner = "application",
  preview = false,
  active = preview,
}: {
  owner?: "application" | "profile";
  preview?: boolean;
  active?: boolean;
}) {
  const id = useId();
  const activeId = useAppStore((state) => state.activeIdentity?.id);
  const saving = usePreferencesStore((state) => state.saving);
  const zoom = useScopedSetting("uiZoom", owner);
  const motion = useScopedSetting("reducedMotion", owner);
  const reading = zoom.reading || motion.reading;
  const unavailable = zoom.unavailable || motion.unavailable;
  const workspace = owner === "profile";

  useEffect(() => {
    if (preview && !unavailable) previewMotion(motion.resolved.value);
  }, [preview, unavailable, motion.resolved.value]);

  useEffect(() => {
    if (!preview) return;

    setGlobalPreview(true);
    return () => {
      previewMotion(null);
      setGlobalPreview(false);
    };
  }, [preview]);

  const change = (key: "uiZoom" | "reducedMotion", value: string) => {
    if (key === "uiZoom") void (value === "global" ? zoom.reset() : zoom.set(Number(value)));
    else void (value === "global" ? motion.reset() : motion.set(value === "true"));
  };

  return (
    <>
      <fieldset
        disabled={workspace && !activeId}
        inert={saving || unavailable}
        aria-busy={saving || reading}
        className="flex min-w-0 flex-col gap-5 border-t border-border-subtle pt-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <label htmlFor={`${id}-zoom`} className="text-sm font-medium">
              {t("settings.appearanceControls.interfaceScale")}
            </label>
            <p className="mt-1 text-xs text-text-secondary">
              {t("settings.appearanceControls.adjustTheSizeOfTextAndControls")}
            </p>
          </div>

          <Select
            id={`${id}-zoom`}
            aria-label={t("settings.appearanceControls.uIZoom")}
            value={zoom.following ? "global" : String(zoom.resolved.value)}
            onValueChange={(value) => change("uiZoom", value)}
            surface="base"
          >
            {workspace && <option value="global">{t("common.followGlobal")}</option>}

            {Array.from(new Set([...UI_ZOOM_PRESETS, zoom.resolved.value]))
              .sort((a, b) => a - b)
              .map((zoom) => (
                <option key={zoom} value={zoom}>
                  {zoom}%
                </option>
              ))}
          </Select>
        </div>

        <div className="space-y-4 border-t border-border-subtle pt-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium">{t("settings.appearanceControls.motion")}</h2>
              <p id={`${id}-motion-hint`} className="mt-1 text-xs text-text-secondary">
                {t("settings.appearanceControls.keepTransitionsAndAnimationsToAMinimum")}
              </p>
            </div>

            {workspace && (
              <Select
                id={`${id}-motion`}
                aria-label={t("settings.appearanceControls.reduceMotion")}
                aria-describedby={`${id}-motion-hint`}
                value={motion.following ? "global" : String(motion.resolved.value)}
                onValueChange={(value) => change("reducedMotion", value)}
                surface="base"
              >
                <option value="global">{t("common.followGlobal")}</option>
                <option value="true">{t("settings.appearanceControls.on")}</option>
                <option value="false">{t("settings.appearanceControls.off")}</option>
              </Select>
            )}
          </div>

          {!workspace && (
            <Checkbox
              checked={motion.resolved.value}
              aria-describedby={`${id}-motion-hint`}
              onChange={(event) => change("reducedMotion", String(event.target.checked))}
            >
              {t("settings.appearanceControls.reduceMotion")}
            </Checkbox>
          )}
        </div>
      </fieldset>

      <BackgroundSettings owner={owner} preview={preview} active={active} />
    </>
  );
}
