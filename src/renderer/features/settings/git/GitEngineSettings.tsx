import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { SettingValues } from "@shared/preferences/settings";
import { useEffect, useId, useState } from "react";
import {
  DefinitionList,
  TextButton,
  StateMessage,
  Disclosure,
  ErrorDialog,
  NoticeBanner,
  RadioCard,
} from "../../../components/ui/index";
import { useRepositoryRead } from "../../../repository/hooks/useRepositoryRead";
import { useAppStore } from "../../../stores/app-store";

export function GitEngineSettings() {
  const [inspect, setInspect] = useState(false);
  const details = useRepositoryRead(() => window.eda.app.gitDiagnostics(), inspect ? true : null);
  const groupName = useId();
  const engine = useAppStore((state) => state.gitEngine);
  const [selected, setSelected] = useState<SettingValues["gitEngine"]>("bundled");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void window.eda.settings
      .resolve("gitEngine", {})
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setSelected(result.value.value);
        else setError(errorMessage(result.error));
      })
      .catch(() => {
        if (!cancelled)
          setError(t("settings.gitEngineSettings.couldNotReadTheGitEnginePreference"));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (value: SettingValues["gitEngine"]) => {
    const previous = selected;

    setSelected(value);
    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.settings.set("gitEngine", { kind: "application" }, value);
      if (!result.ok) {
        setSelected(previous);
        setError(errorMessage(result.error));
      }
    } catch {
      setSelected(previous);
      setError(t("settings.gitEngineSettings.couldNotSaveTheGitEnginePreference"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{t("settings.gitEngineSettings.gitInstallation")}</h2>
      <p className="text-xs leading-relaxed text-text-secondary">
        {t("settings.gitEngineSettings.chooseTheGitInstallationUsedByEveryProfile")}
      </p>
      <fieldset disabled={busy} aria-busy={busy}>
        <div
          role="radiogroup"
          aria-label={t("settings.gitEngineSettings.gitInstallation")}
          className="grid gap-2 sm:grid-cols-2"
        >
          {(
            [
              {
                value: "bundled",
                label: t("settings.gitEngineSettings.bundledGitRecommended"),
                description: t("settings.gitEngineSettings.includedWithEdaAndReadyToUse"),
              },
              {
                value: "custom",
                label: t("settings.tools.git"),
                description: t("settings.tools.gitHint"),
              },
              {
                value: "system",
                label: t("settings.gitEngineSettings.systemGitPath"),
                description: t(
                  "settings.gitEngineSettings.useYourInstalledGitWithBundledGitAsAFallback",
                ),
              },
            ] as const
          ).map((option) => (
            <RadioCard
              key={option.value}
              name={groupName}
              value={option.value}
              checked={selected === option.value}
              onChange={() => void choose(option.value)}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">{option.label}</p>
                <p aria-hidden="true" className="text-xs leading-relaxed text-text-secondary">
                  {option.description}
                </p>
              </div>
              <span
                aria-hidden="true"
                className="radio-control"
                data-checked={selected === option.value}
              />
            </RadioCard>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-text-secondary">
        {t("settings.gitEngineSettings.changesTakeEffectAfterRestartingEda")}
      </p>
      <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      {engine ? (
        <Disclosure
          title={t("settings.gitEngineSettings.runningGitDetails")}
          onToggle={(event) => setInspect(event.currentTarget.open)}
        >
          <div className="mt-3">
            <DefinitionList
              items={[
                { label: t("settings.gitEngineSettings.version"), value: `Git ${engine.version}` },
                {
                  label: t("settings.gitEngineSettings.installation"),
                  value:
                    engine.source === "bundled"
                      ? t("gitEngineSettings.bundledGit")
                      : engine.source === "custom"
                        ? t("settings.tools.git")
                        : t("gitEngineSettings.systemGit"),
                },
                {
                  label: t("settings.gitEngineSettings.executable"),
                  value: (
                    <span className="font-mono text-xs">
                      {details.value?.executable ?? engine.path}
                    </span>
                  ),
                },
                ...(details.value
                  ? [
                      ...(details.value.wsl
                        ? [
                            {
                              label: t("diagnostics.wsl"),
                              value: t(
                                details.value.wsl === "wslg"
                                  ? "diagnostics.wslg"
                                  : "diagnostics.wslLinux",
                              ),
                            },
                          ]
                        : []),
                      { label: t("gitDiagnostics.platform"), value: details.value.platform },
                      {
                        label: t("gitDiagnostics.commands"),
                        value: details.value.commands.join(", "),
                      },
                      {
                        label: t("gitDiagnostics.lfs"),
                        value: details.value.lfsVersion ?? t("gitDiagnostics.lfsMissing"),
                      },
                      {
                        label: t("gitDiagnostics.build"),
                        value: (
                          <pre className="selectable whitespace-pre-wrap">
                            {details.value.build}
                          </pre>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            {inspect && !details.value && (
              <StateMessage
                tone={details.error ? "error" : "loading"}
                title={details.error ?? t("gitDiagnostics.loading")}
                action={
                  details.error && (
                    <TextButton onClick={details.retry}>{t("common.retry")}</TextButton>
                  )
                }
              />
            )}
          </div>
        </Disclosure>
      ) : (
        <NoticeBanner tone="warning">
          {t("settings.gitEngineSettings.noGitInstallationDetected")}
        </NoticeBanner>
      )}
    </section>
  );
}
