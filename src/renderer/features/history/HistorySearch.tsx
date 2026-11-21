import { t } from "@shared/i18n";
import {
  HISTORY_SEARCH_FIELDS,
  isHistorySearchField,
  type HistorySearchField,
  type HistoryPageRequest,
} from "@shared/repository/repository-read";
import { useState } from "react";
import { Button, Dialog, Input, Select, TextButton, StateMessage } from "../../components/ui/index";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useRepositoryStore } from "../../stores/repository-store";

export function HistorySearch({
  repositoryId,
  onClose,
  file,
  onChooseMessage,
}: {
  repositoryId: string;
  onClose: () => void;
  file?: { oid: string; path: string };
  onChooseMessage?: (message: string) => void;
}) {
  const [field, setField] = useState<HistorySearchField>("message");
  const [text, setText] = useState("");
  const [request, setRequest] = useState<HistoryPageRequest | null>(() =>
    file
      ? { repositoryId, refs: [file.oid], limit: 50, search: { field: "path", text: file.path } }
      : onChooseMessage
        ? { repositoryId, limit: 50 }
        : null,
  );
  const { value, error, retry } = useRepositoryRead(window.eda.repository.history, request);
  const title = t(
    onChooseMessage
      ? "commitBox.reuseMessage"
      : file
        ? "historySearch.timeline"
        : "historySearch.title",
  );
  return (
    <Dialog
      title={title}
      description={
        file?.path ?? t(onChooseMessage ? "commitBox.replaceDraft" : "historySearch.scope")
      }
      onClose={onClose}
    >
      {!file && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim())
              setRequest({ repositoryId, limit: 50, search: { field, text: text.trim() } });
          }}
        >
          <Select
            aria-label={title}
            value={field}
            onValueChange={(next) => {
              if (isHistorySearchField(next)) {
                setField(next);
                setText("");
                setRequest(null);
              }
            }}
          >
            {HISTORY_SEARCH_FIELDS.map((item) => (
              <option key={item} value={item}>
                {t(`historySearch.${item}`)}
              </option>
            ))}
          </Select>
          <Input
            autoFocus
            required
            aria-label={t(`historySearch.${field}`)}
            type={field === "since" || field === "until" ? "date" : "text"}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setRequest(null);
            }}
          />
          <Button type="submit">{t("historySearch.run")}</Button>
        </form>
      )}
      {error && (
        <StateMessage
          tone="error"
          title={error}
          action={<TextButton onClick={retry}>{t("common.retry")}</TextButton>}
        />
      )}
      {request && !error && !value && <StateMessage tone="loading" title={title} />}
      {value && (
        <div className="my-2 divide-y divide-border-subtle">
          {!value.commits.length && <StateMessage title={t("historySearch.noMatches")} />}
          {value.commits.map((commit) => (
            <TextButton
              className="flex w-full gap-2 py-1 text-left"
              key={commit.oid}
              onClick={() => {
                if (onChooseMessage)
                  onChooseMessage(
                    commit.body ? commit.subject + "\n\n" + commit.body : commit.subject,
                  );
                else void useRepositoryStore.getState().jumpToCommit(commit.oid);
                onClose();
              }}
            >
              <span className="mono">{commit.oid.slice(0, 8)}</span>
              <span className="truncate">{commit.subject}</span>
            </TextButton>
          ))}
        </div>
      )}
      {request && (
        <div className="flex justify-end gap-2">
          {!!request.offset && (
            <TextButton
              onClick={() => setRequest({ ...request, offset: Math.max(0, request.offset! - 50) })}
            >
              {t("common.back")}
            </TextButton>
          )}
          {value?.nextOffset != null && (
            <TextButton onClick={() => setRequest({ ...request, offset: value.nextOffset! })}>
              {t("common.next")}
            </TextButton>
          )}
        </div>
      )}
    </Dialog>
  );
}
