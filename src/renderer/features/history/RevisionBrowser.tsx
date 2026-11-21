import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { useMemo, useState } from "react";
import {
  CheckboxControl,
  CodeBlock,
  Dialog,
  Select,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";

import { BlameView } from "./BlameView";
import { HistorySearch } from "./HistorySearch";

export function RevisionBrowser({
  repositoryId,
  oid,
  onBack,
  initialPath = "",
}: {
  repositoryId: string;
  oid: string;
  onBack: () => void;
  initialPath?: string;
}) {
  const [timeline, setTimeline] = useState(false);
  const [path, setPath] = useState(initialPath);
  const [blaming, setBlaming] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<string[] | null>(null);
  const [destination, setDestination] = useState<"worktree" | "index" | "both">("worktree");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const restore = async () => {
    if (!review || busy) return;
    setBusy(true);
    try {
      const result = await window.eda.repository.restoreRevision(
        repositoryId,
        oid,
        review,
        destination,
      );
      if (!result.ok) setNotice(errorMessage(result.error));
      else {
        setSelected([]);
        setNotice(t("revision.restored"));
      }
    } catch (failure) {
      setNotice(errorMessage(failure));
    } finally {
      setReview(null);
      setBusy(false);
    }
  };
  const request = useMemo(
    () => ({ repositoryId, oid, ...(path && { path }) }),
    [repositoryId, oid, path],
  );
  const { value, error, retry } = useRepositoryRead(window.eda.repository.revisionPath, request);

  return (
    <section aria-label={t("revision.browse")} className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-10 items-center gap-3 border-b border-border-subtle px-3">
        <TextButton autoFocus onClick={onBack}>
          {t("diffViewer.backToHistory")}
        </TextButton>
        {path && (
          <TextButton
            onClick={() => {
              setBlaming(false);
              setPath(path.split("/").slice(0, -1).join("/"));
            }}
          >
            {t("revision.parent")}
          </TextButton>
        )}
        {value && value.kind !== "tree" && (
          <TextButton onClick={() => setTimeline(true)}>{t("historySearch.timeline")}</TextButton>
        )}
        {value?.kind === "text" && value.text && (
          <TextButton aria-pressed={blaming} onClick={() => setBlaming(!blaming)}>
            {t("revision.blame")}
          </TextButton>
        )}
        {value && ((path && value.kind !== "tree") || selected.length > 0) && (
          <TextButton
            onClick={() => {
              setNotice("");
              setReview(value.kind === "tree" ? selected : [path]);
            }}
          >
            {t("revision.restore")}
          </TextButton>
        )}
        <span className="mono truncate text-xs" title={oid + ":" + path}>
          {oid.slice(0, 8)} / {path}
        </span>
      </header>
      {notice && <p role="status">{notice}</p>}
      {review && (
        <Dialog title={t("revision.restore")} onClose={() => setReview(null)} busy={busy}>
          <ul>
            {review.map((file) => (
              <li className="mono" key={file}>
                {file}
              </li>
            ))}
          </ul>
          <Select
            aria-label={t("revision.destination")}
            value={destination}
            disabled={busy}
            onValueChange={(next) => {
              if (next === "index" || next === "both" || next === "worktree") setDestination(next);
            }}
          >
            <option value="worktree">{t("revision.worktree")}</option>
            <option value="index">{t("revision.index")}</option>
            <option value="both">{t("revision.both")}</option>
          </Select>
          <TextButton disabled={busy} onClick={() => void restore()}>
            {t("revision.replace")}
          </TextButton>
        </Dialog>
      )}
      {timeline && (
        <HistorySearch
          repositoryId={repositoryId}
          file={{ oid, path }}
          onClose={() => setTimeline(false)}
        />
      )}
      {error && (
        <StateMessage
          tone="error"
          title={error}
          action={<TextButton onClick={retry}>{t("common.retry")}</TextButton>}
        />
      )}
      {!error && !value && <StateMessage tone="loading" title={t("revision.browse")} />}
      {value?.kind === "tree" &&
        (value.entries.length ? (
          <VirtualRows
            className="min-h-0 flex-1"
            key={path}
            items={value.entries}
            rowHeight={32}
            renderRow={(entry) => (
              <div key={entry.name} className="flex h-8 items-center gap-2 px-3 text-sm">
                {entry.type === "blob" &&
                  (() => {
                    const file = path ? path + "/" + entry.name : entry.name;
                    return (
                      <CheckboxControl
                        aria-label={t("revision.select", { path: file })}
                        checked={selected.includes(file)}
                        disabled={!selected.includes(file) && selected.length >= 100}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, file]
                              : selected.filter((item) => item !== file),
                          )
                        }
                      />
                    );
                  })()}
                {entry.type === "commit" ? (
                  <span>
                    {entry.name} · {t("revision.submodule", { oid: entry.oid })}
                  </span>
                ) : (
                  <TextButton onClick={() => setPath(path ? path + "/" + entry.name : entry.name)}>
                    {entry.name}
                    {entry.type === "tree" ? "/" : ""}
                  </TextButton>
                )}
              </div>
            )}
          />
        ) : (
          <StateMessage title={t("revision.empty")} />
        ))}
      {value?.kind === "text" && value.lfs && (
        <p className="selectable break-all px-3 py-1 text-xs">{t("revision.lfs", value.lfs)}</p>
      )}
      {value?.kind === "text" && blaming && (
        <BlameView
          repositoryId={repositoryId}
          oid={oid}
          path={path}
          lines={value.text.split("\n").length - Number(value.text.endsWith("\n"))}
        />
      )}
      {value?.kind === "text" && !blaming && (
        <CodeBlock className="min-h-0 flex-1" label={path}>
          {value.text}
        </CodeBlock>
      )}
      {(value?.kind === "large" || value?.kind === "binary") && (
        <StateMessage
          title={t(value.kind === "large" ? "revision.large" : "revision.binary", {
            bytes: value.bytes,
          })}
        />
      )}
    </section>
  );
}
