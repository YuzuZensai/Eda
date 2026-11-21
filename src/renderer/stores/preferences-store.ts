import { errorText } from "@shared/error-codes";
import type { GitErrorData } from "@shared/errors";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { AccentColor } from "@shared/preferences/accent";
import {
  builtInSetting,
  themeForAppearance,
  type BackgroundPreference,
  type ResolvedSetting,
  type SettingKey,
  type SettingsContext,
  type SettingScope,
  type SettingValues,
  type ThemePreference,
} from "@shared/preferences/settings";
import { create } from "zustand";
import { applyIdentityHue, applyTheme, BUILT_IN_THEMES } from "../styles/themes";

const PREFERENCE_KEYS = [
  "developerSettingsEnabled",
  "conventionalCommitsEnabled",
  "vigilantMode",
  "mailboxPreview",
  "showInternalRefs",
  "historyVisibleColumns",
  "compactHistory",
  "historyAvatars",
  "predictUpstreamConflicts",
  "historyDateStyle",
  "commitPrefixes",
  "commitSummaryLimit",
  "shortcutOverrides",
  "toolbarLabels",
  "updateNotices",
  "accentHue",
  "editorExecutable",
  "diffExecutable",
  "theme",
  "background",
  "windowTransparency",
  "syncGlobalGitConfig",
  "reducedMotion",
  "uiZoom",
  "diffMode",
] as const satisfies readonly SettingKey[];

type Values = {
  [K in (typeof PREFERENCE_KEYS)[number]]: ResolvedSetting<K>;
};

const defaults = (): Values =>
  Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, builtInSetting(key)])) as Values;

interface PreferencesState {
  context: SettingsContext;
  values: Values;
  loading: boolean;
  saving: boolean;
  error: GitErrorData | null;
  load: (context: SettingsContext) => Promise<void>;

  set: <K extends SettingKey>(
    key: K,
    scope: SettingScope,
    value: SettingValues[K],
  ) => Promise<boolean>;

  reset: (key: SettingKey, scope: SettingScope) => Promise<boolean>;
}

let generation = 0;
let backgroundAdjustment: { value: BackgroundPreference } | null = null;
let backgroundPreview: BackgroundPreference | null = null;
let motionPreview: boolean | null = null;
let appearancePreview: ThemePreference | null = null;
let accentPreview: AccentColor | null = null;

function apply(values: Values): void {
  applyIdentityHue(accentPreview ?? values.accentHue.value);

  applyTheme(
    BUILT_IN_THEMES.find(
      (theme) =>
        theme.id ===
        themeForAppearance(
          appearancePreview ?? values.theme.value,
          window.matchMedia("(prefers-color-scheme: dark)").matches,
        ),
    ) ?? BUILT_IN_THEMES.find((theme) => theme.id === "eda-dark")!,
  );

  const background = backgroundAdjustment?.value ?? backgroundPreview ?? values.background.value;
  const root = document.documentElement;

  root.dataset["customBackground"] = String(!!background.image);

  const backgroundProperties = {
    "--background-image": background.image
      ? `url("${background.image}")`
      : root.style.getPropertyValue("--background-image") || "none",
    "--background-strength": String(background.image ? background.strength / 100 : 0),
    "--background-blur": `${background.blur}px`,
  };

  for (const [property, value] of Object.entries(backgroundProperties)) {
    if (root.style.getPropertyValue(property) !== value) root.style.setProperty(property, value);
  }

  document.documentElement.dataset["reducedMotion"] = String(
    motionPreview ?? values.reducedMotion.value,
  );
}

export const usePreferencesStore = create<PreferencesState>((set, get) => {
  let pendingMutations = 0;
  let contextGeneration = 0;

  const mutate = async (
    action: () => ReturnType<typeof window.eda.settings.reset>,
  ): Promise<boolean> => {
    const context = get().context;
    const requestContext = contextGeneration;
    const current = () => requestContext === contextGeneration;

    pendingMutations++;
    set({ saving: true, error: null });

    try {
      const result = await action();

      if (!current()) return result.ok;

      if (!result.ok) {
        set({ error: result.error });
        return false;
      }

      await get().load(context);

      return true;
    } catch {
      if (!current()) return false;

      set({
        error: new GitError({
          kind: "unknown",
          operation: t("operations.savePreferences"),
          message: errorText("preferencesStore.preferencesCouldNotBeSavedTryAgain"),
        }).toData(),
      });

      return false;
    } finally {
      pendingMutations--;
      set({ saving: pendingMutations > 0 });
    }
  };

  return {
    context: {},
    values: defaults(),
    loading: false,
    saving: false,
    error: null,
    async load(context) {
      const request = ++generation;
      if (
        context.profileId !== get().context.profileId ||
        context.repositoryId !== get().context.repositoryId
      )
        contextGeneration++;

      if (context.profileId !== get().context.profileId) {
        const values = {
          ...defaults(),
          developerSettingsEnabled: get().values.developerSettingsEnabled,
        };

        set({ context, values, loading: true, error: null });
        apply(values);
      } else set({ context, loading: true, error: null });

      try {
        const results = await Promise.all(
          PREFERENCE_KEYS.map(
            async (key) => [key, await window.eda.settings.resolve(key, context)] as const,
          ),
        );

        if (request !== generation) return;

        const failure = results.find(([, result]) => !result.ok)?.[1];

        if (failure && !failure.ok) {
          set({ loading: false, error: failure.error });
          return;
        }

        const values = Object.fromEntries(
          results.flatMap(([key, result]) => (result.ok ? [[key, result.value]] : [])),
        ) as Values;

        set({ values, loading: false, error: null });
        apply(values);
      } catch {
        if (request !== generation) return;

        set({
          loading: false,
          error: new GitError({
            kind: "unknown",
            operation: t("operations.readPreferences"),
            message: errorText("settings.useScopedSetting.couldNotReadApplicationPreferences"),
          }).toData(),
        });
      }
    },
    set: (key, scope, value) => mutate(() => window.eda.settings.set(key, scope, value)),
    reset: (key, scope) => mutate(() => window.eda.settings.reset(key, scope)),
  };
});

export function preferenceSource(setting: ResolvedSetting): string {
  return setting.source.kind === "built-in"
    ? t("preferencesStore.builtInDefault")
    : setting.source.kind === "application"
      ? t("preferencesStore.globalDefault")
      : setting.source.kind === "profile"
        ? t("preferencesStore.profileOverride")
        : t("preferencesStore.repositoryOverride");
}

export function watchSystemAppearance(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => apply(usePreferencesStore.getState().values);
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}

export function previewAppearance(value: ThemePreference | null): void {
  appearancePreview = value;
  apply(usePreferencesStore.getState().values);
}

export function previewAccent(value: AccentColor | null): void {
  accentPreview = value;
  apply(usePreferencesStore.getState().values);
}

export function previewMotion(value: boolean | null): void {
  motionPreview = value;
  apply(usePreferencesStore.getState().values);
}

export function previewBackground(value: BackgroundPreference | null): void {
  backgroundPreview = value;
  apply(usePreferencesStore.getState().values);
}

export function beginBackgroundAdjustment() {
  const adjustment = {
    value: backgroundPreview ?? usePreferencesStore.getState().values.background.value,
  };

  backgroundAdjustment = adjustment;

  return {
    update(value: BackgroundPreference) {
      if (backgroundAdjustment !== adjustment) return;
      adjustment.value = value;
      apply(usePreferencesStore.getState().values);
    },
    clear() {
      if (backgroundAdjustment !== adjustment) return;
      backgroundAdjustment = null;
      apply(usePreferencesStore.getState().values);
    },
  };
}
