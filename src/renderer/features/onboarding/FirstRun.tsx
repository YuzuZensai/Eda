import { errorText } from "@shared/error-codes";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { parseCommitPrefixes } from "@shared/preferences/commit-prefix";
import {
  builtInSetting,
  SETTING_DEFINITIONS,
  type SettingValues,
} from "@shared/preferences/settings";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  CheckIcon as Check,
  BranchIcon as GitBranch,
} from "../../components/ui/icons";
import { useEffect, useRef, useState } from "react";
import { ViewTransition } from "../../components/layout/ViewTransition";
import { useViewTransition } from "../../components/layout/hooks/useViewTransition";
import { Button, Checkbox, cx, Field, Input } from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import {
  previewAccent,
  previewAppearance,
  previewBackground,
  previewMotion,
  usePreferencesStore,
} from "../../stores/preferences-store";
import { AppearanceStep } from "./AppearanceStep";
import { CommitStyleStep } from "./CommitStyleStep";
import { ConnectionsStep } from "./ConnectionsStep";
import { Welcome, WelcomeBranches, WelcomeComplete } from "./Welcome";

const steps = [
  {
    label: t("firstRun.profile"),
    title: t("firstRun.welcomeToEda"),
    description: t("firstRun.startWithAProfileYourProjectsAndGitIdentityTogetherInOnePlace"),
  },
  {
    label: t("firstRun.appearance"),
    title: t("firstRun.makeEdaYours"),
    description: t("firstRun.setYourDefaultLookYouCanCustomizeEachProfileLater"),
  },
  {
    label: t("firstRun.commits"),
    title: t("firstRun.findYourCommitStyle"),
    description: t("firstRun.writeFreelyOrUseALittleStructureChooseWhatWorksForYou"),
  },
  {
    label: t("firstRun.connect"),
    title: t("firstRun.connectYourTools"),
    description: t("firstRun.yourProfileIsSavedConnectGitHubOr"),
  },
];

export function FirstRun({ onComplete = () => {} }: { onComplete?: (takeTour?: boolean) => void }) {
  const [complete, setComplete] = useState(false);
  const createIdentity = useAppStore((state) => state.createIdentity);
  const activeIdentity = useAppStore((state) => state.activeIdentity);
  const appError = useAppStore((state) => state.error);
  const [initial] = useState(() => usePreferencesStore.getState().values);
  const [step, setStep] = useState(0);
  const [welcome, setWelcome] = useState(true);
  const [intro, setIntro] = useState(true);
  const [name, setName] = useState("");
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [sync, setSync] = useState(initial.syncGlobalGitConfig.value);
  const [theme, setTheme] = useState(() => initial.theme.value);
  const [hue, setHue] = useState(initial.accentHue.value);
  const [reducedMotion, setReducedMotion] = useState(initial.reducedMotion.value);
  const [background, setBackground] = useState(initial.background.value);
  const [conventional, setConventional] = useState(initial.conventionalCommitsEnabled.value);
  const [prefixes, setPrefixes] = useState(initial.commitPrefixes.value.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touchedEmail, setTouchedEmail] = useState(false);
  const edited = useRef({ name: false, gitName: false, gitEmail: false });
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLFieldSetElement>(null);
  const savingRef = useRef(false);
  const navigation = useViewTransition();

  useEffect(() => {
    let alive = true;

    void window.eda.app
      .getGlobalGitUser()
      .then((result) => {
        if (!alive || !result.ok) return;
        const author = result.value.name?.trim() ?? "";
        const email = result.value.email?.trim() ?? "";
        if (!edited.current.name) setName(author.split(/\s+/)[0]!.slice(0, 64));
        if (!edited.current.gitName) setGitName(author);
        if (!edited.current.gitEmail) setGitEmail(email);
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    previewAppearance(theme);
  }, [theme]);

  useEffect(() => {
    previewAccent(hue);
  }, [hue]);

  useEffect(() => {
    previewBackground(background);
  }, [background]);

  useEffect(() => {
    previewMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(
    () => () => {
      previewAppearance(null);
      previewAccent(null);
      previewBackground(null);
      previewMotion(null);
    },
    [],
  );

  useEffect(() => {
    if (!welcome) heading.current?.focus({ preventScroll: true });
    content.current?.scrollTo?.({ top: 0 });
  }, [step, welcome]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gitEmail.trim());
  const emailError = touchedEmail && gitEmail !== "" && !emailValid;
  const canSave = name.trim() !== "" && gitName.trim() !== "" && emailValid;
  const parsedPrefixes = parseCommitPrefixes(prefixes);
  const prefixesValid = SETTING_DEFINITIONS.commitPrefixes.validate(parsedPrefixes);
  const go = (next: number) => {
    if (savingRef.current) return;

    navigation.transition(
      () => {
        setIntro(false);
        setStep(next);
      },
      next < step ? "back" : "forward",
    );
  };

  const save = async () => {
    if (!canSave || (conventional && !prefixesValid) || savingRef.current) return;

    savingRef.current = true;
    setSaving(true);
    setError(null);
    useAppStore.getState().dismissError();

    try {
      const saveGlobal = async <
        K extends
          | "theme"
          | "accentHue"
          | "background"
          | "reducedMotion"
          | "conventionalCommitsEnabled"
          | "commitPrefixes",
      >(
        key: K,
        value: SettingValues[K],
      ) => {
        const preferences = usePreferencesStore.getState();
        const current = preferences.values[key];
        if (current && JSON.stringify(current.value) === JSON.stringify(value)) return true;
        return preferences.set(key, { kind: "application" }, value);
      };

      if (
        !(await saveGlobal("theme", theme)) ||
        !(await saveGlobal("accentHue", hue)) ||
        !(await saveGlobal("background", background)) ||
        !(await saveGlobal("reducedMotion", reducedMotion)) ||
        !(await saveGlobal("conventionalCommitsEnabled", conventional)) ||
        (prefixesValid && !(await saveGlobal("commitPrefixes", parsedPrefixes)))
      ) {
        setError(
          errorMessage(
            usePreferencesStore.getState().error,
            errorText("firstRun.yourPreferencesCouldNotBeSavedTryAgain"),
          ),
        );
        return;
      }

      const created = await createIdentity(
        {
          name: name.trim(),
          gitName: gitName.trim(),
          gitEmail: gitEmail.trim(),
          hue: builtInSetting("accentHue").value,
          signing: { format: "none", signCommits: false },
        },
        { syncGlobalGitConfig: sync },
      );

      if (created) navigation.transition(() => setStep(3), "forward");

      if (!created)
        setError(
          errorMessage(
            useAppStore.getState().error,
            errorText("firstRun.yourProfileCouldNotBeCreatedTryAgain"),
          ),
        );
    } catch {
      setError(t("firstRun.setupCouldNotBeCompletedYourChoicesAreStillHereTryAgain"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const current = steps[step]!;
  const stage = complete ? steps.length + 1 : step + 1;
  let commitStyle: "emoji" | "plain" | "free" = "emoji";

  if (step >= 2 && !welcome) {
    if (!conventional) commitStyle = "free";
    else if (!/\p{Extended_Pictographic}/u.test(prefixes)) commitStyle = "plain";
  }

  let continueLabel = t("common.continue");

  if (saving) continueLabel = t("firstRun.settingThingsUp");
  else if (step === 3) continueLabel = t("firstRun.startUsingEda");

  return (
    <div
      data-intro={intro}
      data-complete={complete}
      className="onboarding-shell relative isolate flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden bg-bg-base"
    >
      <WelcomeBranches
        quiet={!welcome}
        stage={welcome && !complete ? 0 : stage}
        stepCount={steps.length}
        commitStyle={commitStyle}
      />

      {complete && (
        <ViewTransition ref={navigation.ref} className="min-h-full">
          <WelcomeComplete onOpen={() => onComplete(false)} onTour={() => onComplete(true)} />
        </ViewTransition>
      )}

      {!complete && welcome && (
        <ViewTransition ref={navigation.ref} className="min-h-full">
          <Welcome onStart={() => navigation.transition(() => setWelcome(false), "forward")} />
        </ViewTransition>
      )}

      {!complete && !welcome && (
        <div className="relative z-10 mx-auto flex h-full min-h-0 w-full max-w-[28rem] shrink-0 flex-col px-6 py-6">
          <nav aria-label={t("firstRun.setupProgress")} className="mb-8 shrink-0">
            <ol className="flex gap-4">
              {steps.map((item, index) => (
                <li
                  key={item.label}
                  aria-current={step === index ? "step" : undefined}
                  className="min-w-0 flex-1"
                >
                  <div className="mb-2 h-0.5 overflow-hidden rounded-full bg-border-subtle">
                    <div
                      className="onboarding-progress h-full origin-left bg-accent"
                      data-active={index <= step}
                    />
                  </div>

                  <span
                    className={cx(
                      "flex items-center gap-1.5 text-xs",
                      index === step ? "font-medium text-text-primary" : "text-text-tertiary",
                    )}
                  >
                    {index < step ? (
                      <Check
                        className="onboarding-check"
                        size={12}
                        aria-label={t("firstRun.completed")}
                      />
                    ) : (
                      <span className="font-mono text-[10px]">0{index + 1}</span>
                    )}

                    {item.label}
                  </span>
                </li>
              ))}
            </ol>
          </nav>

          <form
            noValidate
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (savingRef.current) return;
              if (step < 2) {
                if (canSave) go(step + 1);
              } else if (step === 2) void save();
            }}
          >
            <fieldset
              ref={content}
              disabled={saving}
              className="-mx-6 min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pb-4"
            >
              <ViewTransition ref={navigation.ref} className="min-w-0">
                <div className="min-w-0">
                  <div className="onboarding-heading mb-6">
                    {step === 0 && (
                      <div className="onboarding-mark mb-5 text-accent-text" aria-hidden="true">
                        <GitBranch size={36} strokeWidth={1.5} />
                      </div>
                    )}

                    <h1
                      ref={heading}
                      tabIndex={-1}
                      className="text-2xl font-semibold leading-tight tracking-[-0.035em] outline-none"
                    >
                      {current.title}
                    </h1>

                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                      {current.description}
                    </p>
                  </div>

                  {step === 0 && (
                    <div className="onboarding-fields space-y-4">
                      <Field
                        label={t("firstRun.profileName")}
                        hint={t("firstRun.personalWorkOrWhateverFits")}
                      >
                        {(props) => (
                          <Input
                            {...props}
                            autoFocus
                            maxLength={64}
                            value={name}
                            onChange={(event) => {
                              edited.current.name = true;
                              setName(event.target.value);
                            }}
                            placeholder={t("firstRun.personal")}
                          />
                        )}
                      </Field>

                      <Field label={t("firstRun.gitAuthorName")}>
                        {(props) => (
                          <Input
                            {...props}
                            maxLength={128}
                            value={gitName}
                            onChange={(event) => {
                              edited.current.gitName = true;
                              setGitName(event.target.value);
                            }}
                            placeholder={t("firstRun.yourFullName")}
                          />
                        )}
                      </Field>

                      <Field
                        label={t("firstRun.gitEmail")}
                        hint={t("firstRun.yourAuthorNameAndEmailAppearOnCommits")}
                        error={emailError ? t("firstRun.enterACompleteEmailAddress") : undefined}
                      >
                        {(props) => (
                          <Input
                            {...props}
                            mono
                            type="email"
                            value={gitEmail}
                            onChange={(event) => {
                              edited.current.gitEmail = true;
                              setGitEmail(event.target.value);
                            }}
                            onBlur={() => setTouchedEmail(true)}
                            invalid={emailError}
                            placeholder={t("firstRun.youExampleCom")}
                          />
                        )}
                      </Field>

                      <div className="space-y-1.5 border-t border-border-subtle pt-4">
                        <Checkbox
                          checked={sync}
                          onChange={(event) => setSync(event.target.checked)}
                        >
                          {t("firstRun.syncThisProfileWithGlobalGit")}
                        </Checkbox>

                        <p className="text-xs leading-relaxed text-text-tertiary">
                          {t("firstRun.activatingThisProfileUpdatesGlobalGitAuthorAnd")}
                        </p>
                      </div>
                    </div>
                  )}

                  {step === 1 && (
                    <AppearanceStep
                      theme={theme}
                      hue={hue}
                      onTheme={setTheme}
                      onHue={setHue}
                      background={background}
                      onBackground={setBackground}
                      reducedMotion={reducedMotion}
                      onReducedMotion={setReducedMotion}
                    />
                  )}

                  {step === 3 && activeIdentity && (
                    <ConnectionsStep profileId={activeIdentity.id} />
                  )}

                  {step === 2 && (
                    <CommitStyleStep
                      enabled={conventional}
                      prefixes={prefixes}
                      onEnabled={setConventional}
                      onPrefixes={setPrefixes}
                    />
                  )}
                </div>
              </ViewTransition>
            </fieldset>

            {(error || appError) && (
              <p role="alert" className="py-3 text-sm text-git-deleted">
                {error || errorMessage(appError)}
              </p>
            )}

            <footer className="onboarding-footer mt-5 flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle pt-5">
              {step > 0 && step < 3 && (
                <Button
                  variant="ghost"
                  icon={<ArrowLeft size={14} />}
                  disabled={saving}
                  onClick={() => go(step - 1)}
                >
                  {t("common.back")}
                </Button>
              )}

              <Button
                className="ml-auto"
                type={step === 3 ? "button" : "submit"}
                onClick={
                  step === 3
                    ? () => {
                        setComplete(true);
                      }
                    : undefined
                }
                variant="primary"
                busy={saving}
                disabled={!canSave || (step === 2 && conventional && !prefixesValid)}
              >
                {continueLabel}

                {!saving && <ArrowRight size={14} aria-hidden="true" />}
              </Button>
            </footer>
          </form>

          <p className="mt-5 shrink-0 text-center text-xs text-text-tertiary">
            {t("firstRun.youCanChangeTheseLaterInSettings")}
          </p>
        </div>
      )}
    </div>
  );
}
