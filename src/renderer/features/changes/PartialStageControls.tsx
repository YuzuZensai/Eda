import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { PartialStagePreview, PartialStageRequest } from "@shared/repository/repository-write";
import { MinusIcon as Minus, PlusIcon as Plus } from "../../components/ui/icons";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DialogActions,
  CheckboxControl,
  CodeBlock,
  Dialog,
  ErrorDialog,
  TextButton,
} from "../../components/ui/index";
import type { UnifiedRow } from "../../repository/diff-model";
import type { RepositorySelection } from "../../stores/repository-state";
import { useRepositoryStore } from "../../stores/repository-store";
import { DiscardDialog } from "./DiscardDialog";

const Context = createContext<{
  selection: Extract<RepositorySelection, { kind: "change" }>;
  selected: ReadonlySet<string>;
  toggle: (key: string) => void;
  hunk: (index: number) => void;
  discard: ((index?: number) => void) | null;
  busy: boolean;
  verb: string;
  error: string | null;
  prepareSelected: () => void;
  clearSelected: () => void;
  discardSelected: (() => void) | null;
} | null>(null);

export function PartialStageProvider({
  children,
  disabled = false,
  inactive = false,
  selection,
  sourceDigest,
}: {
  children: ReactNode;
  disabled?: boolean;
  inactive?: boolean;
  selection?: RepositorySelection;
  sourceDigest?: string | undefined;
}) {
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const writing = useRepositoryStore((state) => state.writing);
  const diff = useRepositoryStore((state) => state.diff);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [preview, setPreview] = useState<PartialStagePreview | null>(null);

  const [discard, setDiscard] = useState<{ request: PartialStageRequest; paths: string[] } | null>(
    null,
  );

  const [busy, setBusy] = useState(false);
  const preparing = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected((current) => (current.size ? new Set() : current));
  }, [diff]);

  useEffect(() => {
    if (inactive) {
      setPreview(null);
      setDiscard(null);
      setError(null);
    }
  }, [inactive]);

  if (disabled || !repositoryId || selection?.kind !== "change" || selection.area === "conflicted")
    return <Context.Provider value={null}>{children}</Context.Provider>;

  const area = selection.area === "staged" ? "staged" : "unstaged";
  const verb =
    area === "staged" ? t("partialStageControls.unstage") : t("partialStageControls.stage");

  const selectedLines = () =>
    [...selected].map((key) => {
      const [hunk, line] = key.split(":").map(Number);
      return { hunk: hunk!, line: line! };
    });

  const prepareDiscard = (hunk?: number) => {
    if (!sourceDigest) return;
    setDiscard({
      paths: [selection.path],
      request: {
        repositoryId,
        path: selection.path,
        sourceDigest,
        area: "unstaged",
        ...(hunk !== undefined
          ? { hunks: [hunk] }
          : {
              lines: selectedLines(),
            }),
      },
    });
  };

  const prepare = async (hunks?: number[]) => {
    if (!sourceDigest || preparing.current || writing) return;

    preparing.current = true;

    const owner = useRepositoryStore.getState();

    setBusy(true);
    setError(null);

    try {
      const result = await window.eda.repository.previewPartial({
        repositoryId,
        path: selection.path,
        sourceDigest,
        area,
        ...(hunks
          ? { hunks }
          : {
              lines: selectedLines(),
            }),
      });

      const current = useRepositoryStore.getState();

      if (
        !mounted.current ||
        current.repositoryId !== repositoryId ||
        current.identityId !== owner.identityId ||
        current.selection !== owner.selection ||
        current.diff !== owner.diff
      )
        return;

      if (!result.ok) setError(errorMessage(result.error));
      else if (hunks) {
        if (await current.applyPartial(result.value.token)) setSelected(new Set());
      } else setPreview(result.value);
    } catch {
      if (mounted.current)
        setError(t("partialStageControls.couldNotUpdateTheSelectedChangesTryAgain"));
    } finally {
      preparing.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;

    setBusy(true);

    const token = preview.token;

    setPreview(null);

    try {
      if (await useRepositoryStore.getState().applyPartial(token)) setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Context.Provider
      value={{
        selection,
        selected,
        busy: busy || writing,
        verb,
        toggle: (key) =>
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          }),
        hunk: (index) => void prepare([index]),
        discard: area === "unstaged" ? prepareDiscard : null,
        error,
        prepareSelected: () => void prepare(),
        clearSelected: () => setSelected(new Set()),
        discardSelected: area === "unstaged" ? () => prepareDiscard() : null,
      }}
    >
      {children}

      {!inactive && discard && (
        <DiscardDialog
          repositoryId={repositoryId}
          paths={discard.paths}
          partial={discard.request}
          onClose={() => setDiscard(null)}
        />
      )}

      {!inactive && preview && (
        <Dialog
          title={t("partialStageControls.selectedChanges", { verb: verb })}
          description={t("partialStageControls.reviewTheExactPatchThatWillUpdateThe")}
          onClose={() => setPreview(null)}
          busy={writing || busy}
          footer={
            <DialogActions
              busy={writing || busy}
              onClose={() => setPreview(null)}
              onConfirm={() => void apply()}
              confirmLabel={t("partialStageControls.changes", { verb: verb })}
              confirmVariant="secondary"
            />
          }
        >
          <p className="mb-2 text-xs text-text-secondary">
            +{preview.additions} -{preview.deletions}
          </p>
          <CodeBlock label={t("partialStageControls.patchToApply")} className="max-h-[45vh]">
            {preview.patch}
          </CodeBlock>
        </Dialog>
      )}
    </Context.Provider>
  );
}

export function PartialStageToolbar({ fileOnly = false }: { fileOnly?: boolean }) {
  const context = useContext(Context);
  const status = useRepositoryStore((state) => state.status);
  const stage = useRepositoryStore((state) => state.stage);
  const unstage = useRepositoryStore((state) => state.unstage);

  if (!context) return null;

  const { selection } = context;

  const staged = selection.area === "staged";
  const fileLabel = staged ? t("diffViewer.unstageFile") : t("diffViewer.stageFile");

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-1 text-xs">
        {!fileOnly && (
          <span className="min-w-0 flex-1 truncate text-text-tertiary">
            {context.selected.size
              ? t("partialStageControls.linesSelected", { size: context.selected.size })
              : t("partialStageControls.selectChangedLinesOrStageUnstageAHunk")}
          </span>
        )}

        <div className="ml-auto flex max-w-full flex-wrap items-center gap-3">
          {!fileOnly && (
            <TextButton
              disabled={!context.selected.size || context.busy}
              className="shrink-0"
              tone="accent"
              onClick={context.prepareSelected}
            >
              {t("partialStageControls.selectedLines", { verb: context.verb })}
            </TextButton>
          )}

          <TextButton
            disabled={context.busy || !status || status.capabilities?.write === false}
            className="flex shrink-0 items-center gap-1.5"
            tone="accent"
            title={fileLabel}
            onClick={() => {
              if (staged) void unstage([selection.path]);
              else void stage([selection.path]);
            }}
          >
            {staged ? (
              <Minus size={14} aria-hidden="true" />
            ) : (
              <Plus size={14} aria-hidden="true" />
            )}

            {fileLabel}
          </TextButton>

          {!fileOnly && (
            <>
              {context.selected.size > 0 && (
                <TextButton onClick={context.clearSelected}>
                  {t("partialStageControls.clear")}
                </TextButton>
              )}

              {context.discardSelected && context.selected.size > 0 && (
                <TextButton disabled={context.busy} tone="danger" onClick={context.discardSelected}>
                  {t("partialStageControls.discardSelectedLines")}
                </TextButton>
              )}
            </>
          )}
        </div>
      </div>

      {context.error && <ErrorDialog>{context.error}</ErrorDialog>}
    </>
  );
}

export function PartialLineControl({ row }: { row: UnifiedRow }) {
  const context = useContext(Context);

  if (!context || row.hunkIndex === undefined) return null;

  if (row.kind === "hunk")
    return (
      <>
        <TextButton
          disabled={context.busy}
          className="select-none shrink-0 px-2"
          tone="accent"
          aria-label={t("partialStageControls.hunkActionLabel", {
            verb: context.verb,
            value2: row.hunkIndex + 1,
          })}
          onClick={() => context.hunk(row.hunkIndex!)}
        >
          {t("partialStageControls.hunk", { verb: context.verb })}
        </TextButton>

        {context.discard && (
          <TextButton
            disabled={context.busy}
            className="select-none shrink-0 px-2"
            tone="danger"
            aria-label={t("partialStageControls.discardHunk", { value1: row.hunkIndex + 1 })}
            onClick={() => context.discard?.(row.hunkIndex)}
          >
            {t("partialStageControls.discard")}
          </TextButton>
        )}
      </>
    );

  if ((row.kind !== "addition" && row.kind !== "deletion") || row.lineIndex === undefined)
    return <span className="w-6 shrink-0" />;

  const key = `${row.hunkIndex}:${row.lineIndex}`;

  return (
    <span className="flex w-6 shrink-0 justify-center">
      <CheckboxControl
        aria-label={t("partialStageControls.selectLine", {
          value1:
            row.kind === "addition"
              ? t("partialStageControls.added")
              : t("partialStageControls.deleted"),
          value2: row.newLineNumber ?? row.oldLineNumber,
        })}
        checked={context.selected.has(key)}
        disabled={context.busy}
        onChange={() => context.toggle(key)}
      />
    </span>
  );
}
