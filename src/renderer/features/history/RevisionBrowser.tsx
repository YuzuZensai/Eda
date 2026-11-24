import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { RevisionPath } from "@shared/repository/repository-read";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FileIcon,
  FolderGit2Icon,
  FolderIcon,
  GitCommitHorizontalIcon,
  HistoryIcon,
  LinkIcon,
} from "../../components/ui/icons";
import {
  Button,
  Checkbox,
  CodeBlock,
  cx,
  Dialog,
  DialogActions,
  Field,
  ListItemButton,
  Select,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";

import { BlameView } from "./BlameView";
import { HistorySearch } from "./HistorySearch";

function RevisionDirectory({
  entries,
  path,
  selected,
  onSelect,
  onOpen,
}: {
  entries: Extract<RevisionPath, { kind: "tree" }>["entries"];
  path: string;
  selected: string[] | null;
  onSelect: (files: string[]) => void;
  onOpen: (path: string) => void;
}) {
  const ordered = useMemo(
    () => entries.toSorted((a, b) => Number(b.type === "tree") - Number(a.type === "tree")),
    [entries],
  );

  return (
    <VirtualRows
      className="min-h-0 flex-auto"
      items={ordered}
      rowHeight={36}
      horizontalScroll={false}
      renderRow={(entry) => {
        const file = path ? path + "/" + entry.name : entry.name;
        const name = <span className="min-w-0 flex-1 truncate">{entry.name}</span>;

        if (entry.type === "commit")
          return (
            <div
              key={file}
              title={file}
              className="flex h-9 items-center gap-2 border-b border-border-subtle px-3 text-sm text-text-secondary"
            >
              <LinkIcon aria-hidden="true" className="shrink-0" />
              {name}
              <span className="mono truncate text-xs" title={entry.oid}>
                {t("revision.submodule", { oid: entry.oid.slice(0, 8) })}
              </span>
            </div>
          );

        if (selected && entry.type === "blob") {
          const checked = selected.includes(file);
          return (
            <Checkbox
              key={file}
              title={file}
              aria-label={t("revision.select", { path: file })}
              className="flex h-9 w-full border-b border-border-subtle px-3 hover:bg-bg-raised has-[:checked]:bg-accent-muted"
              checked={checked}
              disabled={!checked && selected.length >= 100}
              onChange={() =>
                onSelect(checked ? selected.filter((item) => item !== file) : [...selected, file])
              }
            >
              {name}
            </Checkbox>
          );
        }

        return (
          <ListItemButton
            key={file}
            title={file}
            className="h-9 rounded-none border-b border-border-subtle px-3"
            onClick={() => onOpen(file)}
          >
            {entry.type === "tree" ? (
              <FolderIcon aria-hidden="true" className="shrink-0 text-accent-text" />
            ) : (
              <FileIcon aria-hidden="true" className="shrink-0 text-text-tertiary" />
            )}
            {name}
            {entry.type === "tree" && (
              <ChevronRightIcon aria-hidden="true" className="shrink-0 text-text-tertiary" />
            )}
          </ListItemButton>
        );
      }}
    />
  );
}

export function RevisionBrowser({
  repositoryId,
  repositoryName,
  oid,
  onBack,
  initialPath = "",
}: {
  repositoryId: string;
  repositoryName: string;
  oid: string;
  onBack: () => void;
  initialPath?: string;
}) {
  const [timeline, setTimeline] = useState(false);
  const [path, setPath] = useState(initialPath);
  const [blaming, setBlaming] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null);
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
        setSelected(null);
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

  const location = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    location.current?.focus();
  }, [path]);

  const parts = path ? path.split("/") : [];
  const openPath = (next: string) => {
    setBlaming(false);
    setNotice("");
    setPath(next);
  };

  return (
    <section
      aria-label={t("revision.snapshot")}
      className="app-surface-panel flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 border-b border-border-subtle px-3 py-1">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeftIcon aria-hidden="true" />}
          onClick={onBack}
        >
          {t("diffViewer.backToHistory")}
        </Button>
        <h2 className="border-l border-border-subtle pl-3 text-sm font-semibold">
          {t("revision.snapshot")}
        </h2>
        <span
          className="mono inline-flex items-center gap-1.5 rounded-sm bg-bg-raised px-2 py-1 text-xs text-text-secondary"
          title={oid}
        >
          <GitCommitHorizontalIcon aria-hidden="true" />
          {oid.slice(0, 8)}
        </span>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-2 p-3 sm:p-5">
        <nav
          aria-label={t("revision.path")}
          className="flex shrink-0 flex-wrap items-center gap-1.5 py-1 text-sm"
        >
          <FolderGit2Icon aria-hidden="true" className="shrink-0 text-text-tertiary" />
          {[repositoryName, ...parts].map((name, index) => (
            <Fragment key={index}>
              {index > 0 && (
                <ChevronRightIcon aria-hidden="true" className="shrink-0 text-text-tertiary" />
              )}
              {index === parts.length ? (
                <span
                  ref={location}
                  tabIndex={-1}
                  aria-current="page"
                  className="max-w-full truncate font-semibold"
                  title={name}
                >
                  {name}
                </span>
              ) : (
                <TextButton
                  className="max-w-full truncate"
                  onClick={() => openPath(parts.slice(0, index).join("/"))}
                >
                  {name}
                </TextButton>
              )}
            </Fragment>
          ))}
        </nav>

        {notice && (
          <p role="status" className="text-sm text-text-secondary">
            {notice}
          </p>
        )}

        <div
          className={cx(
            "flex min-h-0 flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-surface",
            value?.kind !== "tree" && "flex-1",
          )}
        >
          {value && (
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle bg-bg-inset px-3 py-1">
              {value.kind === "tree" ? (
                <>
                  <span className="mr-auto text-xs text-text-secondary">
                    {t("revision.items", { count: value.entries.length })}
                  </span>
                  {selected && selected.length > 0 && (
                    <Button size="sm" onClick={() => setReview(selected)}>
                      {t("revision.restoreSelected", { count: selected.length })}
                    </Button>
                  )}
                  {(selected || value.entries.some((entry) => entry.type === "blob")) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(selected ? null : [])}
                    >
                      {t(selected ? "common.cancel" : "revision.selectFiles")}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<HistoryIcon aria-hidden="true" />}
                    onClick={() => setTimeline(true)}
                  >
                    {t("historySearch.timeline")}
                  </Button>
                  {value.kind === "text" && !!value.text && (
                    <Button
                      variant={blaming ? "secondary" : "ghost"}
                      size="sm"
                      aria-pressed={blaming}
                      onClick={() => setBlaming(!blaming)}
                    >
                      {t("revision.blame")}
                    </Button>
                  )}
                  <Button size="sm" className="ml-auto" onClick={() => setReview([path])}>
                    {t("revision.restore")}
                  </Button>
                </>
              )}
            </div>
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
              <RevisionDirectory
                entries={value.entries}
                path={path}
                selected={selected}
                onSelect={setSelected}
                onOpen={openPath}
              />
            ) : (
              <StateMessage className="flex-1" title={t("revision.empty")} />
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
            <CodeBlock className="min-h-0 max-h-none flex-1 rounded-none border-0" label={path}>
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
        </div>
      </div>

      {review && (
        <Dialog
          title={t("revision.restore")}
          onClose={() => setReview(null)}
          busy={busy}
          footer={
            <DialogActions
              busy={busy}
              onClose={() => setReview(null)}
              onConfirm={() => void restore()}
              confirmLabel={t("revision.replace")}
            />
          }
        >
          <ul className="mb-4 max-h-48 overflow-auto rounded-sm border border-border-subtle bg-bg-inset p-2">
            {review.map((file) => (
              <li className="mono break-all text-xs" key={file}>
                {file}
              </li>
            ))}
          </ul>
          <Field label={t("revision.destination")}>
            {(field) => (
              <Select
                {...field}
                value={destination}
                disabled={busy}
                onValueChange={(next) => {
                  if (next === "index" || next === "both" || next === "worktree")
                    setDestination(next);
                }}
              >
                <option value="worktree">{t("revision.worktree")}</option>
                <option value="index">{t("revision.index")}</option>
                <option value="both">{t("revision.both")}</option>
              </Select>
            )}
          </Field>
        </Dialog>
      )}
      {timeline && (
        <HistorySearch
          repositoryId={repositoryId}
          file={{ oid, path }}
          onClose={() => setTimeline(false)}
        />
      )}
    </section>
  );
}
