import { errorText, type ErrorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import { GitError } from "../errors";
import { supportedLocales } from "../i18n";
import { isCommitIdentity, type CommitIdentity } from "../identity/identity";
import type { SshAgentMode } from "../identity/ssh";
import type { GitEnginePreference } from "../integrations/git-engine";
import { defaultMergeTool, isMergeTool, type MergeTool } from "../integrations/merge-tool";
import { isOneOf, isRecord } from "../validation";
import type { DiffMode } from "../repository/repository-read";
import { isPullStrategy, type PullStrategy } from "../workflows/pull";
import { isHexColor, type AccentColor } from "./accent";
import { DEFAULT_COMMIT_PREFIXES, isCommitPrefix } from "./commit-prefix";
import { GRAPH_COLUMN_IDS, type GraphColumnId } from "./graph-view";

export type SettingScope =
  | { kind: "application" }
  | { kind: "profile"; profileId: string }
  | { kind: "repository"; profileId: string; repositoryId: string };

export interface SettingsContext {
  profileId?: string;
  repositoryId?: string;
}

interface Definition<T> {
  defaultValue: T;
  scopes: readonly SettingScope["kind"][];
  validate: (value: unknown) => value is T;
}

const define = <T>(definition: Definition<T>): Definition<T> => definition;
const boolean = (v: unknown): v is boolean => typeof v === "boolean";
const optionalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  (value === "" ||
    (value.length <= 4096 &&
      /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value) &&
      !/[\x00-\x1f]/.test(value)));
const application = ["application"] as const;
const profile = ["application", "profile"] as const;
const repository = ["application", "profile", "repository"] as const;
export const THEME_FAMILIES = [
  { name: "Eda", light: "eda-light", dark: "eda-dark" },
  { name: "Lavender", light: "lavender-light", dark: "lavender-dark" },
  { name: "Nord", light: "nord-light", dark: "nord" },
] as const;

export const LIGHT_THEME_IDS = THEME_FAMILIES.map((family) => family.light);
export const DARK_THEME_IDS = THEME_FAMILIES.map((family) => family.dark);

export interface ThemePreference {
  mode: "system" | "light" | "dark";
  light: string;
  dark: string;
}

export function themeForAppearance(value: ThemePreference, systemDark: boolean): string {
  return value.mode === "dark" || (value.mode === "system" && systemDark)
    ? value.dark
    : value.light;
}

function isThemePreference(value: unknown): value is ThemePreference {
  if (!isRecord(value)) return false;

  const preference = value;

  return (
    isOneOf(preference["mode"], ["system", "light", "dark"]) &&
    isOneOf(preference["light"], LIGHT_THEME_IDS) &&
    isOneOf(preference["dark"], DARK_THEME_IDS)
  );
}

export const MAX_BACKGROUND_IMAGE_LENGTH = 1_500_000;
export const MAX_BACKGROUND_BLUR = 30;
export const MIN_WINDOW_OPACITY = 60;
export const UI_ZOOM_PRESETS = [75, 90, 100, 110, 125, 150, 175, 200] as const;
export const UI_ZOOM_RANGE = { min: UI_ZOOM_PRESETS[0], max: UI_ZOOM_PRESETS.at(-1)! } as const;

export interface BackgroundPreference {
  image: string;
  strength: number;
  blur: number;
}

export interface WindowTransparency {
  enabled: boolean;
  opacity: number;
}

const percentage = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;

export const SETTING_DEFINITIONS = {
  repositoryRoot: define<string>({
    defaultValue: "",
    scopes: ["profile"],
    validate: optionalAbsolutePath,
  }),
  historyVisibleColumns: define<GraphColumnId[]>({
    defaultValue: [...GRAPH_COLUMN_IDS],
    scopes: profile,
    validate: (value): value is GraphColumnId[] =>
      Array.isArray(value) &&
      value.length <= GRAPH_COLUMN_IDS.length &&
      value.every((id: unknown) => isOneOf(id, GRAPH_COLUMN_IDS)) &&
      new Set(value).size === value.length,
  }),
  showInternalRefs: define<boolean>({
    defaultValue: false,
    scopes: application,
    validate: boolean,
  }),
  developerSettingsEnabled: define<boolean>({
    defaultValue: false,
    scopes: application,
    validate: boolean,
  }),
  language: define<string>({
    defaultValue: "system",
    scopes: application,
    validate: (value): value is string =>
      typeof value === "string" && (value === "system" || supportedLocales.includes(value)),
  }),
  automaticUpdateChecks: define<boolean>({
    defaultValue: true,
    scopes: application,
    validate: boolean,
  }),
  includePrereleaseUpdates: define<boolean>({
    defaultValue: true,
    scopes: application,
    validate: boolean,
  }),
  repositoryCommitIdentity: define<CommitIdentity | null>({
    defaultValue: null,
    scopes: ["repository"],
    validate: (value): value is CommitIdentity | null => value === null || isCommitIdentity(value),
  }),
  conventionalCommitsEnabled: define<boolean>({
    defaultValue: false,
    scopes: profile,
    validate: boolean,
  }),
  vigilantMode: define<boolean>({
    defaultValue: false,
    scopes: profile,
    validate: boolean,
  }),
  commitPrefixes: define<string[]>({
    defaultValue: DEFAULT_COMMIT_PREFIXES,
    scopes: profile,
    validate: (value): value is string[] =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 50 &&
      value.every(isCommitPrefix) &&
      new Set(value).size === value.length,
  }),
  accentHue: define<AccentColor>({
    defaultValue: 210,
    scopes: profile,
    validate: (value): value is AccentColor =>
      isHexColor(value) ||
      (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 360),
  }),
  background: define<BackgroundPreference>({
    defaultValue: { image: "", strength: 20, blur: 2 },
    scopes: profile,
    validate: (value): value is BackgroundPreference => {
      if (!isRecord(value)) return false;

      const v = value;

      return (
        typeof v["image"] === "string" &&
        (v["image"] === "" ||
          (v["image"].length <= MAX_BACKGROUND_IMAGE_LENGTH &&
            /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(v["image"]))) &&
        percentage(v["strength"]) &&
        typeof v["blur"] === "number" &&
        Number.isInteger(v["blur"]) &&
        v["blur"] >= 0 &&
        v["blur"] <= MAX_BACKGROUND_BLUR
      );
    },
  }),
  windowTransparency: define<WindowTransparency>({
    defaultValue: { enabled: false, opacity: 95 },
    scopes: profile,
    validate: (value): value is WindowTransparency => {
      if (!isRecord(value)) return false;
      const v = value;
      return (
        boolean(v["enabled"]) && percentage(v["opacity"]) && v["opacity"] >= MIN_WINDOW_OPACITY
      );
    },
  }),
  mergeTool: define<MergeTool>({
    defaultValue: defaultMergeTool(),
    scopes: profile,
    validate: isMergeTool,
  }),
  fetchPrune: define<boolean>({
    defaultValue: true,
    scopes: repository,
    validate: boolean,
  }),
  fetchTags: define<boolean>({
    defaultValue: false,
    scopes: repository,
    validate: boolean,
  }),
  backgroundFetchMinutes: define<number>({
    defaultValue: 5,
    scopes: ["application", "repository"],
    validate: (value): value is number =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      (value === 0 || (value >= 1 && value <= 1440)),
  }),
  pullStrategy: define<PullStrategy>({
    defaultValue: "ff",
    scopes: repository,
    validate: isPullStrategy,
  }),
  editorExecutable: define<string>({
    defaultValue: "",
    scopes: profile,
    validate: optionalAbsolutePath,
  }),
  hardwareAcceleration: define<boolean>({
    defaultValue: true,
    scopes: application,
    validate: boolean,
  }),
  sshAgent: define<SshAgentMode>({
    defaultValue: "builtin",
    scopes: application,
    validate: (value): value is SshAgentMode => value === "builtin" || value === "system",
  }),
  gitEngine: define<GitEnginePreference>({
    defaultValue: "bundled",
    scopes: application,
    validate: (value): value is GitEnginePreference => value === "bundled" || value === "system",
  }),
  theme: define<ThemePreference>({
    defaultValue: { mode: "system", light: "eda-light", dark: "eda-dark" },
    scopes: profile,
    validate: isThemePreference,
  }),
  syncGlobalGitConfig: define<boolean>({
    defaultValue: true,
    scopes: profile,
    validate: boolean,
  }),
  reducedMotion: define<boolean>({
    defaultValue: false,
    scopes: profile,
    validate: boolean,
  }),
  uiZoom: define<number>({
    defaultValue: 100,
    scopes: profile,
    validate: (v): v is number =>
      typeof v === "number" &&
      Number.isInteger(v) &&
      v >= UI_ZOOM_RANGE.min &&
      v <= UI_ZOOM_RANGE.max,
  }),
  diffMode: define<DiffMode>({
    defaultValue: "unified",
    scopes: repository,
    validate: (v): v is DiffMode => v === "unified" || v === "split",
  }),
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

export type SettingValues = { [K in SettingKey]: (typeof SETTING_DEFINITIONS)[K]["defaultValue"] };

export interface ResolvedSetting<K extends SettingKey = SettingKey> {
  key: K;
  value: SettingValues[K];
  source: SettingScope | { kind: "built-in" };
  hasOverride: boolean;
}

export interface SettingChanged {
  key: SettingKey;
  scope: SettingScope;
}

export function builtInSetting<K extends SettingKey>(key: K): ResolvedSetting<K> {
  return {
    key,
    value: structuredClone(SETTING_DEFINITIONS[key].defaultValue) as SettingValues[K],
    source: { kind: "built-in" },
    hasOverride: false,
  };
}

export function requireSettingKey(value: unknown): SettingKey {
  if (typeof value !== "string" || !Object.hasOwn(SETTING_DEFINITIONS, value))
    throw invalid(errorText("shared.settings.unknownPreference"));
  return value as SettingKey;
}

export function validateSetting<K extends SettingKey>(
  key: K,
  scope: SettingScope,
  value: unknown,
): asserts value is SettingValues[K] {
  if (!(SETTING_DEFINITIONS[key].scopes as readonly string[]).includes(scope.kind))
    throw invalid(
      errorText("shared.settings.thePreferenceCannotBeChangedAtScope", {
        key: key,
        kind: scope.kind,
      }),
    );
  if (!SETTING_DEFINITIONS[key].validate(value))
    throw invalid(errorText("shared.settings.invalidValueFor", { key: key }));
}

export function settingScopes(context: SettingsContext): SettingScope[] {
  const result: SettingScope[] = [{ kind: "application" }];

  if (context.profileId) {
    result.push({ kind: "profile", profileId: context.profileId });

    if (context.repositoryId)
      result.push({
        kind: "repository",
        profileId: context.profileId,
        repositoryId: context.repositoryId,
      });
  } else if (context.repositoryId)
    throw invalid(errorText("shared.settings.repositoryPreferencesRequireAProfile"));

  return result;
}

function invalid(message: ErrorText): GitError {
  return new GitError({ kind: "invalid-input", operation: t("operations.preferences"), message });
}
