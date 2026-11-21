import { useState } from "react";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  flowKinds,
  type FlowAction,
  type FlowConfig,
  type FlowKind,
  type FlowPlan,
} from "@shared/workflows/gitflow";
import type { PushPreview } from "@shared/integrations/remotes";
import {
  Checkbox,
  Disclosure,
  Field,
  Input,
  Select,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";

export function GitflowTools({ id, onChange }: { id: string; onChange: () => void }) {
  const state = useRepositoryRead(window.eda.repository.flowState, id);
  const [config, setConfig] = useState<FlowConfig>({
    production: "main",
    development: "develop",
    feature: "feature/",
    release: "release/",
    hotfix: "hotfix/",
  });
  const [kind, setKind] = useState<FlowKind>("feature");
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("origin");
  const [retain, setRetain] = useState(true);
  const [plan, setPlan] = useState<FlowPlan | null>(null);
  const [push, setPush] = useState<PushPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const change = async (action: FlowAction) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    setPush(null);
    try {
      const result = await window.eda.repository.gitflow(id, action);
      setPlan(result.ok ? result.value : null);
      if (!result.ok) setNotice(errorMessage(result.error));
      else if (action.kind !== "preview") setNotice(t("flow.done"));
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      if (action.kind !== "preview") onChange();
      state.retry();
      setBusy(false);
    }
  };
  const publish = async () => {
    if (!state.value?.config || busy) return;
    setBusy(true);
    setNotice("");
    try {
      if (push) {
        const result = await window.eda.remotes.push(id, push.token);
        setNotice(result.ok ? t("flow.done") : errorMessage(result.error));
        setPush(null);
      } else {
        const branch = state.value.config[kind] + name;
        const result = await window.eda.remotes.preparePush({
          repositoryId: id,
          remote,
          branch,
          destination: branch,
          mode: "normal",
          setUpstream: true,
        });
        if (result.ok) setPush(result.value);
        else setNotice(errorMessage(result.error));
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const reviewed = state.value?.pending ?? plan;
  return (
    <div className="space-y-2">
      {state.error && (
        <StateMessage
          title={state.error}
          tone="error"
          action={<TextButton onClick={state.retry}>{t("common.retry")}</TextButton>}
        />
      )}
      {!state.value && !state.error && <StateMessage tone="loading" title={t("flow.title")} />}
      {state.value && (
        <fieldset disabled={busy} className="space-y-2">
          {!state.value.config ? (
            <>
              {(["production", "development", ...flowKinds] as const).map((key) => (
                <Field
                  key={key}
                  label={
                    key === "production" || key === "development"
                      ? t(`flow.${key}`)
                      : t("flow.prefix", { kind: t(`flow.${key}`) })
                  }
                >
                  {(field) => (
                    <Input
                      {...field}
                      value={config[key]}
                      onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                    />
                  )}
                </Field>
              ))}
              <TextButton onClick={() => void change({ kind: "configure", config })}>
                {t("flow.configure")}
              </TextButton>
            </>
          ) : (
            <>
              {!state.value.pending && (
                <>
                  <Field label={t("flow.type")}>
                    {(field) => (
                      <Select
                        {...field}
                        value={kind}
                        onValueChange={(v) => {
                          if (v === "feature" || v === "hotfix" || v === "release") {
                            setKind(v);
                            setPush(null);
                            setPlan(null);
                          }
                        }}
                      >
                        {flowKinds.map((item) => (
                          <option key={item} value={item}>
                            {t(`flow.${item}`)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t("flow.name")}>
                    {(field) => (
                      <Input
                        {...field}
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setPlan(null);
                          setPush(null);
                        }}
                      />
                    )}
                  </Field>
                  <Checkbox
                    checked={retain}
                    onChange={(e) => {
                      setRetain(e.target.checked);
                      setPlan(null);
                    }}
                  >
                    {t("flow.retain")}
                  </Checkbox>
                  <TextButton
                    disabled={!name}
                    onClick={() => void change({ kind: "start", type: kind, name, retain })}
                  >
                    {t("flow.start")}
                  </TextButton>
                  <TextButton
                    disabled={!name}
                    onClick={() => void change({ kind: "preview", type: kind, name, retain })}
                  >
                    {t("flow.preview")}
                  </TextButton>
                  <Disclosure title={t("flow.publish")}>
                    <Field label={t("flow.remote")}>
                      {(field) => (
                        <Input
                          {...field}
                          value={remote}
                          onChange={(e) => {
                            setRemote(e.target.value);
                            setPush(null);
                          }}
                        />
                      )}
                    </Field>
                    {push && (
                      <p className="mono selectable">
                        {push.source} → {push.url} · {push.destination}
                      </p>
                    )}
                    <TextButton disabled={!name || !remote} onClick={() => void publish()}>
                      {t(push ? "flow.confirmPublish" : "flow.publish")}
                    </TextButton>
                  </Disclosure>
                </>
              )}
              {reviewed && (
                <div className="space-y-2">
                  <ul>
                    {reviewed.targets.map((target) => (
                      <li key={target.name}>
                        {t("flow.merge", { branch: reviewed.branch, target: target.name })}
                      </li>
                    ))}
                    {reviewed.tag && <li>{t("flow.tag", { tag: reviewed.tag })}</li>}
                    {!reviewed.retain && <li>{t("flow.delete", { branch: reviewed.branch })}</li>}
                  </ul>
                  <TextButton
                    onClick={() =>
                      void change(
                        state.value?.pending
                          ? { kind: "resume" }
                          : { kind: "finish", plan: reviewed },
                      )
                    }
                  >
                    {t(state.value.pending ? "flow.resume" : "flow.finish")}
                  </TextButton>
                  {state.value.pending && (
                    <TextButton onClick={() => void change({ kind: "retain" })}>
                      {t("flow.keep")}
                    </TextButton>
                  )}
                </div>
              )}
            </>
          )}
        </fieldset>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
