import { t } from "@shared/i18n";
import { isTerminalOptions, type TerminalOptions } from "@shared/repository/terminal";
import { useState } from "react";
import { Button, Checkbox, Field, Input, Select, Textarea } from "../../../components/ui/index";
import { usePreferencesStore } from "../../../stores/preferences-store";
import { useScopedSetting } from "../hooks/useScopedSetting";

export function TerminalSettings() {
  const setting = useScopedSetting("terminalOptions", "profile");
  const saving = usePreferencesStore((state) => state.saving);
  const [edits, setEdits] = useState<Partial<TerminalOptions>>({});
  const [environment, setEnvironment] = useState<string>();
  const [outcome, setOutcome] = useState<"idle" | "success" | "error">("idle");
  const options = { ...setting.resolved.value, ...edits };
  const environmentText =
    environment ??
    Object.entries(options.environment)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");

  const update = (change: Partial<TerminalOptions>) => {
    setEdits((current) => ({ ...current, ...change }));
    setOutcome("idle");
  };

  const save = async () => {
    const entries: [string, string][] = [];
    for (const line of environmentText.split("\n").filter(Boolean)) {
      const separator = line.indexOf("=");
      if (separator < 1) {
        setOutcome("error");
        return;
      }
      entries.push([line.slice(0, separator), line.slice(separator + 1)]);
    }

    const value = { ...options, environment: Object.fromEntries(entries) };
    if (!isTerminalOptions(value)) {
      setOutcome("error");
      return;
    }

    setOutcome((await setting.set(value)) ? "success" : "idle");
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="max-w-2xl space-y-4" disabled={setting.unavailable || saving}>
        <div className="grid gap-4 sm:grid-cols-2">
          {(["shell", "font", "size", "scrollback"] as const).map((key) => {
            const number = key === "size" || key === "scrollback";
            return (
              <Field key={key} label={t(`terminal.${key}`)}>
                {(field) => (
                  <Input
                    {...field}
                    type={number ? "number" : "text"}
                    value={options[key]}
                    onChange={(event) =>
                      update({ [key]: number ? Number(event.target.value) : event.target.value })
                    }
                  />
                )}
              </Field>
            );
          })}
          <Field label={t("terminal.cursor")}>
            {(field) => (
              <Select
                {...field}
                value={options.cursor}
                onValueChange={(cursor) => {
                  if (cursor === "bar" || cursor === "block" || cursor === "underline")
                    update({ cursor });
                }}
              >
                {(["bar", "block", "underline"] as const).map((cursor) => (
                  <option key={cursor} value={cursor}>
                    {t(`terminal.${cursor}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Checkbox
          checked={options.completion}
          onChange={(event) => update({ completion: event.target.checked })}
        >
          {t("terminal.completion")}
        </Checkbox>

        <Field label={t("terminal.env")}>
          {(field) => (
            <Textarea
              {...field}
              rows={4}
              value={environmentText}
              onChange={(event) => {
                setEnvironment(event.target.value);
                setOutcome("idle");
              }}
            />
          )}
        </Field>

        {outcome === "error" && (
          <p role="alert" className="text-sm text-git-deleted">
            {t("terminal.invalidSettings")}
          </p>
        )}
        <Button type="submit" variant="primary" size="sm" busy={saving} feedback={outcome}>
          {t("common.save")}
        </Button>
      </fieldset>
    </form>
  );
}
