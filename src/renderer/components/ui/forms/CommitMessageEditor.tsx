import { t } from "@shared/i18n";
import { matchCommitPrefix } from "@shared/preferences/commit-prefix";
import { splitCommitMessage } from "@shared/repository/commit-message";
import type { KeyboardEventHandler } from "react";
import { CommitPrefixPicker } from "./CommitPrefixPicker";
import { CommitTitleInput } from "./CommitTitleInput";
import { Textarea } from "./FormControls";

interface CommitMessageEditorProps {
  message: string;
  onChange: (message: string) => void;
  conventional: boolean;
  prefixes: string[];
  summaryLimit: number;
  disabled?: boolean;
  autoFocus?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>;
}

export function CommitMessageEditor({
  message,
  onChange,
  conventional,
  prefixes,
  summaryLimit,
  disabled = false,
  autoFocus = false,
  onKeyDown,
}: CommitMessageEditorProps) {
  const { title, messageTail, description } = splitCommitMessage(message);
  const recognized = conventional ? matchCommitPrefix(title, prefixes) : null;
  const selectedPrefix = recognized?.[1] ?? "";
  const subject = recognized ? title.slice(recognized[0].length) : title;
  const length = Array.from(title).length;

  const composeTitle = (value: string) => {
    const typed = conventional ? matchCommitPrefix(value, prefixes) : null;
    const prefix = typed ?? recognized;
    const subject = typed ? value.slice(typed[0].length) : value;

    return prefix ? `${prefix[1]}${prefix[2] ?? ""}${prefix[3] ?? ""}: ${subject}` : subject;
  };

  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-2">
        {conventional && (
          <CommitPrefixPicker
            value={selectedPrefix}
            prefixes={prefixes}
            disabled={disabled}
            onChange={(prefix) =>
              onChange(
                `${prefix ? `${prefix}${recognized?.[2] ?? ""}${recognized?.[3] ?? ""}: ` : ""}${subject}${messageTail}`,
              )
            }
          />
        )}

        <div className="min-w-0 flex-1">
          <CommitTitleInput
            value={subject}
            onChange={(value) => onChange(`${composeTitle(value)}${messageTail}`)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            autoFocus={autoFocus}
          />
        </div>
      </div>

      {summaryLimit > 0 && length > summaryLimit && (
        <p role="status" className="text-xs text-text-secondary">
          {t("commitBox.summaryGuidance", { length, limit: summaryLimit })}
        </p>
      )}

      <Textarea
        spellCheck
        rows={2}
        value={description}
        onChange={(event) =>
          onChange(event.target.value ? `${title}\n\n${event.target.value}` : title)
        }
        onKeyDown={onKeyDown}
        placeholder={t("commitBox.descriptionOptional")}
        aria-label={t("commitBox.commitDescription")}
        disabled={disabled}
        surface="base"
        className="leading-snug"
      />
    </div>
  );
}
