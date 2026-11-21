import { t } from "@shared/i18n";
import { useMemo, useState } from "react";
import { StateMessage, TextButton } from "../../components/ui/index";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useRepositoryStore } from "../../stores/repository-store";

export function BlameView({
  repositoryId,
  oid,
  path,
  lines,
}: {
  repositoryId: string;
  oid: string;
  path: string;
  lines: number;
}) {
  const [start, setStart] = useState(1);
  const request = useMemo(
    () => ({ repositoryId, oid, path, start }),
    [repositoryId, oid, path, start],
  );
  const { value, error, retry } = useRepositoryRead(window.eda.repository.blame, request);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-3 border-b border-border-subtle px-3 py-1">
        <TextButton disabled={start === 1} onClick={() => setStart(start - 100)}>
          {t("common.back")}
        </TextButton>
        <TextButton disabled={start + 100 > lines} onClick={() => setStart(start + 100)}>
          {t("common.next")}
        </TextButton>
      </div>
      {error && (
        <StateMessage
          tone="error"
          title={error}
          action={<TextButton onClick={retry}>{t("common.retry")}</TextButton>}
        />
      )}
      {!value && !error && <StateMessage tone="loading" title={t("revision.blame")} />}
      <ol start={start} className="selectable min-h-0 flex-1 overflow-auto">
        {value?.map((line, i) => (
          <li
            key={start + i}
            className="flex min-w-max items-center gap-3 border-b border-border-subtle px-3 text-xs"
          >
            <span className="mono w-10 text-right">{start + i}</span>
            <TextButton onClick={() => void useRepositoryStore.getState().jumpToCommit(line.oid)}>
              {line.oid.slice(0, 8)}
            </TextButton>
            <span className="w-32 truncate" title={line.author}>
              {line.author}
            </span>
            {line.previous && (
              <TextButton
                onClick={() => {
                  if (line.previous)
                    useRepositoryStore.setState({
                      contentView: { kind: "tree", ...line.previous },
                    });
                }}
              >
                {t("revision.previous")}
              </TextButton>
            )}
            <code className="whitespace-pre">{line.text}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}
