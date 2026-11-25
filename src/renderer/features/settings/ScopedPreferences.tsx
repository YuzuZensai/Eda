import { t } from "@shared/i18n";
import {
  builtInSetting,
  type ResolvedSetting,
  type SettingScope,
} from "@shared/preferences/settings";
import { useEffect, useState } from "react";
import { Button, Checkbox, NoticeBanner } from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { previewAppearance, usePreferencesStore } from "../../stores/preferences-store";
import { ThemePreferences } from "./appearance/ThemePreferences";
import { CommitPrefixSettings } from "./git/CommitPrefixSettings";
import { useScopedSetting } from "./hooks/useScopedSetting";

const APPEARANCE_SETTINGS = [
  "theme",
  "accentHue",
  "uiZoom",
  "reducedMotion",
  "background",
  "windowTransparency",
  "historyVisibleColumns",
  "vigilantMode",
] as const;

interface ScopedPreferencesProps {
  owner: "application" | "profile";
  section: "appearance" | "git";
  preview?: boolean;
}

export function ScopedPreferences(props: ScopedPreferencesProps) {
  const profileId = useAppStore((state) => state.activeIdentity?.id);

  return <ScopedPreferencesContent key={JSON.stringify([props.owner, profileId])} {...props} />;
}

function ScopedPreferencesContent({ owner, section, preview = false }: ScopedPreferencesProps) {
  const active = useAppStore((state) => state.activeIdentity);
  const values = usePreferencesStore((state) => state.values);
  const loading = usePreferencesStore((state) => state.loading);
  const saving = usePreferencesStore((state) => state.saving);
  const [theme, setTheme] = useState<ResolvedSetting<"theme">>(() => builtInSetting("theme"));

  const [sync, setSync] = useState<ResolvedSetting<"syncGlobalGitConfig">>(() =>
    builtInSetting("syncGlobalGitConfig"),
  );

  const appearance = useScopedSetting("theme", owner);
  const gitSync = useScopedSetting("syncGlobalGitConfig", owner);
  const reading = appearance.reading || gitSync.reading;
  const unavailable = appearance.unavailable || gitSync.unavailable;
  const [following, setFollowing] = useState(false);

  const scope: SettingScope =
    owner === "profile" && active
      ? { kind: "profile", profileId: active.id }
      : { kind: "application" };

  useEffect(() => {
    if (!appearance.unavailable) setTheme(appearance.resolved);
  }, [appearance.unavailable, appearance.resolved]);

  useEffect(() => {
    if (!gitSync.unavailable) setSync(gitSync.resolved);
  }, [gitSync.unavailable, gitSync.resolved]);

  useEffect(() => {
    if (preview && !unavailable) previewAppearance(theme.value);
  }, [preview, unavailable, theme]);

  useEffect(() => {
    if (!preview) return;
    return () => previewAppearance(null);
  }, [preview]);

  const hasAppearanceOverrides = APPEARANCE_SETTINGS.some(
    (key) => values[key].source.kind === "profile",
  );

  const followGlobalAppearance = async () => {
    if (!active) return;

    const target = { kind: "profile", profileId: active.id } as const;

    setFollowing(true);

    try {
      for (const key of APPEARANCE_SETTINGS) {
        if (useAppStore.getState().activeIdentity?.id !== target.profileId) return;
        if (!(await usePreferencesStore.getState().reset(key, target))) return;
      }
    } finally {
      setFollowing(false);
    }
  };

  const resettable = (setting: ResolvedSetting) => setting.source.kind === scope.kind;

  return (
    <fieldset
      inert={loading || unavailable || saving || following}
      aria-busy={loading || reading || saving || following}
      className="flex min-w-0 flex-col gap-6"
    >
      {section === "appearance" && (
        <div className="space-y-4">
          {preview && active && hasAppearanceOverrides && (
            <NoticeBanner
              tone="warning"
              action={
                <Button size="sm" variant="secondary" onClick={() => void followGlobalAppearance()}>
                  {t("settings.scopedPreferences.followGlobalForAllAppearance")}
                </Button>
              }
            >
              <p className="font-medium">
                {t("settings.scopedPreferences.previewingGlobalAppearance")}
              </p>
              <p>{t("settings.scopedPreferences.profileOverridesReturnWhenYouLeaveThisPage")}</p>
            </NoticeBanner>
          )}

          <ThemePreferences
            value={theme.value}
            inheritance={
              owner === "profile"
                ? {
                    following: theme.source.kind !== "profile",
                    onFollow: () => void appearance.reset(),
                  }
                : undefined
            }
            onChange={(value) => {
              const previous = theme;

              setTheme({ ...theme, value, source: scope });

              void appearance.set(value).then((saved) => {
                if (
                  !saved &&
                  (owner === "application" ||
                    useAppStore.getState().activeIdentity?.id === active?.id)
                )
                  setTheme(previous);
              });
            }}
          />
        </div>
      )}

      {section === "git" && <CommitPrefixSettings owner={owner} />}

      {section === "git" && (
        <div className="border-b border-border-subtle pb-4">
          <h2 className="mb-3 text-sm font-medium">
            {t("settings.scopedPreferences.gitConfiguration")}
          </h2>

          <Checkbox
            className="flex items-center gap-3 text-sm"
            checked={sync.value}
            onChange={(event) => {
              const previous = sync;

              setSync({ ...sync, value: event.target.checked });

              void gitSync.set(event.target.checked).then((saved) => {
                if (
                  !saved &&
                  (owner === "application" ||
                    useAppStore.getState().activeIdentity?.id === active?.id)
                )
                  setSync(previous);
              });
            }}
          >
            {owner === "profile"
              ? t("settings.scopedPreferences.syncThisProfileSIdentityToGit")
              : t("settings.scopedPreferences.syncProfileIdentitiesToGit")}
          </Checkbox>

          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            {owner === "profile"
              ? t("settings.scopedPreferences.updateGlobalGitAuthorAndSigningSettingsWhenMessage")
              : t("settings.scopedPreferences.updateGlobalGitAuthorAndSigningSettingsWhen")}
          </p>

          {owner === "profile" && resettable(sync) && (
            <div className="mt-3">
              <Button size="sm" variant="secondary" onClick={() => void gitSync.reset()}>
                {t("common.followGlobal")}
              </Button>
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}
