import { t } from "@shared/i18n";
import { stateLabel } from "@shared/i18n/labels";
import type { ComparisonFile } from "@shared/repository/repository-read";
import type { ComponentPropsWithRef } from "react";
import { FileStatusIcon, fileStatusTone } from "../../components/ui/display/FileStatusIcon";
import { ButtonBase } from "../../components/ui/index";

export function ChangedFileButton({
  file,
  path,
  label,
  selected,
  onSelect,
  onKeyDown,
  ref,
  tour,
}: {
  file: ComparisonFile & { binary?: boolean };
  path: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  tour?: string | undefined;
} & Pick<ComponentPropsWithRef<"button">, "ref" | "onKeyDown">) {
  const name =
    file.oldPath && file.newPath && file.oldPath !== file.newPath
      ? t("commitChangesPanel.to", { oldPath: file.oldPath, path })
      : path;

  return (
    <ButtonBase
      ref={ref}
      data-tour={tour}
      aria-label={label}
      aria-pressed={selected}
      title={`${stateLabel(file.status)}: ${name}`}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`ui-interactive flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left text-xs hover:bg-bg-raised ${selected ? "bg-accent-muted text-accent-text" : "text-text-secondary"}`}
    >
      <span
        aria-label={stateLabel(file.status)}
        className={`mono flex w-3.5 shrink-0 items-center justify-center ${fileStatusTone(file.status)}`}
      >
        <FileStatusIcon status={file.status} />
      </span>

      <span className="min-w-0 flex-1 truncate">{name}</span>

      {file.binary && (
        <span className="shrink-0 text-text-tertiary">{t("commitChangesPanel.binary")}</span>
      )}
    </ButtonBase>
  );
}
