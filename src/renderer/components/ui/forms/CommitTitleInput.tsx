import { t } from "@shared/i18n";
import { Input, type InputProps } from "./Input";

type CommitTitleInputProps = Omit<InputProps, "value" | "onChange" | "onPaste"> & {
  value: string;
  onChange: (value: string) => void;
};

export function CommitTitleInput({ value, onChange, ...props }: CommitTitleInputProps) {
  return (
    <Input
      size="sm"
      spellCheck
      aria-label={t("commitBox.commitTitle")}
      placeholder={t("commitBox.commitTitle")}
      {...props}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onPaste={(event) => {
        const text = event.clipboardData.getData("text/plain");

        if (!/[\r\n]/.test(text)) return;

        event.preventDefault();
        const field = event.currentTarget;

        onChange(
          `${value.slice(0, field.selectionStart ?? value.length)}${text.replace(/\r\n?/g, "\n")}${value.slice(field.selectionEnd ?? value.length)}`,
        );
      }}
    />
  );
}
