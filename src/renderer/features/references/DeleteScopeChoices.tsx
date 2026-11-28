import { t } from "@shared/i18n";
import { Radio } from "../../components/ui/index";

export type DeleteScope = "local" | "remote" | "both";
export function deleteScopes(local: boolean, remote: boolean) {
  return (
    [
      ["local", t("referenceMenu.localOnly"), local],
      ["remote", t("referenceMenu.remoteOnly"), remote],
      ["both", t("referenceMenu.localAndRemote"), local && remote],
    ] as const
  ).filter(([, , available]) => available);
}
export function DeleteScopeChoices({
  name,
  choices,
  scope,
  onChange,
}: {
  name: string;
  choices: ReturnType<typeof deleteScopes>;
  scope: DeleteScope;
  onChange: (value: DeleteScope) => void;
}) {
  return choices.map(([value, label]) => (
    <label key={value} className="flex items-center gap-2">
      <Radio name={name} value={value} checked={scope === value} onChange={() => onChange(value)} />
      {label}
    </label>
  ));
}
