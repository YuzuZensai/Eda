import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { t } from "@shared/i18n";
import { boundDiff } from "@shared/repository/diff-limits";
import type {
  DiffMode,
  RevisionComparison as Comparison,
  RevisionComparisonMode,
  RevisionComparisonRequest,
} from "@shared/repository/repository-read";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { ArrowLeftIcon } from "../../components/ui/icons";
import {
  Button,
  Field,
  IconButton,
  Input,
  SegmentedControl,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { useLocalReferences } from "../../repository/hooks/useLocalReferences";
import { useAppStore } from "../../stores/app-store";
import { DiffContent } from "../diff/DiffContent";
import {
  DiffDisplayControls,
  useDiffDisplay,
  DiffLayoutControls,
  useDiffLayout,
} from "../diff/DiffLayout";
import { ChangedFileButton } from "./ChangedFileButton";

function ComparisonFiles({
  comparison,
  repositoryId,
  layout,
}: {
  comparison: Comparison;
  repositoryId: string;
  layout: DiffMode;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const file = comparison.files[selectedIndex];
  const display = useDiffDisplay();
  const { options } = display;
  const request = useMemo(() => {
    const path = file?.newPath ?? file?.oldPath;
    if (!path) return null;

    return {
      repositoryId,
      ...options,
      baseOid: comparison.baseOid,
      rightOid: comparison.rightOid,
      path,
      ...(file?.oldPath && file.oldPath !== path && { oldPath: file.oldPath }),
    };
  }, [comparison, file, repositoryId, options]);

  const { value, error, retry } = useRepositoryRead(window.eda.repository.comparisonDiff, request);
  const diff = useMemo(() => value && boundDiff(value), [value]);

  if (!file)
    return <StateMessage className="flex-1" title={t("commitChangesPanel.noChangedFiles")} />;

  const fileCount = t("comparison.changedFiles", {
    count: comparison.files.length + comparison.omittedFiles,
  });

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(14rem,27%)]">
      <div className="flex min-h-0 min-w-0 flex-col">
        {!diff?.files[0]?.binary && <DiffDisplayControls {...display} />}
        {error ? (
          <StateMessage
            className="flex-1"
            tone="error"
            title={t("diffViewer.couldNotLoadChanges")}
            description={error}
            action={<TextButton onClick={retry}>{t("diffViewer.retryFileDiff")}</TextButton>}
          />
        ) : !diff ? (
          <StateMessage className="flex-1" tone="loading" title={t("diffViewer.loadingDiff")} />
        ) : diff.files.length ? (
          <DiffContent
            diff={diff}
            mode={layout}
            wrap={display.wrap}
            groupContext={!!options.context}
            readOnly
          />
        ) : (
          <StateMessage className="flex-1" title={t("diffViewer.noTextualChanges")} />
        )}
      </div>

      <section className="flex min-h-0 min-w-0 flex-col border-l border-border-subtle bg-bg-surface">
        <h3 className="border-b border-border-subtle px-3 py-2 text-sm font-medium">{fileCount}</h3>
        <VirtualRows
          items={comparison.files}
          rowHeight={36}
          ariaLabel={t("commitChangesPanel.fileChanges")}
          className="min-h-0 flex-1"
          horizontalScroll={false}
          renderRow={(entry, index) => {
            const path = entry.newPath ?? entry.oldPath!;

            return (
              <ChangedFileButton
                key={path}
                file={entry}
                path={path}
                label={t("comparison.viewFile", { path })}
                selected={selectedIndex === index}
                onSelect={() => setSelectedIndex(index)}
              />
            );
          }}
        />
        {comparison.omittedFiles > 0 && (
          <p
            role="status"
            className="border-t border-border-subtle px-3 py-2 text-xs text-text-tertiary"
          >
            {t("commitChangesPanel.additionalFilesOmittedByThePreviewLimit", {
              omittedFiles: comparison.omittedFiles,
            })}
          </p>
        )}
      </section>
    </div>
  );
}

function RevisionInput({
  label,
  value,
  onChange,
  references,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  references: readonly string[];
}) {
  const list = useId();
  const query = value.toLowerCase();
  const suggestions = references.filter((name) => name.toLowerCase().includes(query)).slice(0, 100);

  return (
    <Field label={label}>
      {(field) => (
        <>
          <Input
            {...field}
            mono
            size="sm"
            list={list}
            value={value}
            required
            spellCheck={false}
            autoComplete="off"
            placeholder={t("comparison.revisionPlaceholder")}
            onChange={(event) => onChange(event.target.value)}
          />
          <datalist id={list}>
            {suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </>
      )}
    </Field>
  );
}

export function RevisionComparison({
  repositoryId,
  initialLeft = "",
  initialRight = "HEAD",
  onBack,
}: {
  repositoryId: string;
  initialLeft?: string | undefined;
  initialRight?: string | undefined;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const profileId = useAppStore((state) => state.activeIdentity?.id);
  const layout = useDiffLayout(profileId, repositoryId);
  const [left, setLeft] = useState(initialLeft);
  const [right, setRight] = useState(initialRight);
  const [mode, setMode] = useState<RevisionComparisonMode>("direct");
  const [request, setRequest] = useState<RevisionComparisonRequest | null>(() =>
    initialLeft && initialRight
      ? { repositoryId, left: initialLeft, right: initialRight, mode: "direct" }
      : null,
  );

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const { references, loadError, retry: retryReferences } = useLocalReferences(repositoryId);
  const names = useMemo(
    () =>
      references
        ? [
            ...references.branches.map(
              (branch) => `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`,
            ),
            ...references.tags.map((tag) => `refs/tags/${tag.name}`),
          ]
        : [],
    [references],
  );

  const {
    value: comparison,
    error,
    retry,
  } = useRepositoryRead(window.eda.repository.compareRevisions, request);
  const summary = (result: Comparison, length?: number) =>
    t(mode === "direct" ? "comparison.directResult" : "comparison.mergeBaseResult", {
      left: result.leftOid.slice(0, length),
      right: result.rightOid.slice(0, length),
      base: result.baseOid.slice(0, length),
    });

  return (
    <section
      aria-label={t("comparison.title")}
      className="app-canvas flex min-h-0 flex-1 flex-col bg-bg-base"
    >
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface px-3">
        <IconButton
          size="sm"
          aria-label={t("diffViewer.backToHistory")}
          title={t("diffViewer.backToHistory")}
          icon={<ArrowLeftIcon size={16} />}
          onClick={onBack}
        />
        <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold">
          {t("comparison.title")}
        </h2>
      </header>

      <form
        className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-end gap-3 border-b border-border-subtle bg-bg-surface px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (left.trim() && right.trim())
            setRequest({ repositoryId, left: left.trim(), right: right.trim(), mode });
        }}
      >
        <RevisionInput
          label={t("comparison.from")}
          value={left}
          references={names}
          onChange={(value) => {
            setLeft(value);
            setRequest(null);
          }}
        />
        <RevisionInput
          label={t("comparison.to")}
          value={right}
          references={names}
          onChange={(value) => {
            setRight(value);
            setRequest(null);
          }}
        />
        <SegmentedControl<RevisionComparisonMode>
          label={t("comparison.mode")}
          value={mode}
          options={[
            { value: "direct", label: t("comparison.direct") },
            { value: "merge-base", label: t("comparison.mergeBase") },
          ]}
          onChange={(next) => {
            if (mode === next) return;
            setMode(next);
            if (request) setRequest({ ...request, mode: next });
          }}
        />
        <Button type="submit" variant="primary" size="sm" disabled={!left.trim() || !right.trim()}>
          {t("comparison.compare")}
        </Button>
      </form>

      {loadError && (
        <p role="status" className="px-3 py-1 text-xs text-text-secondary">
          {t("manageReferencesDialog.referencesCouldNotBeLoaded")}{" "}
          <TextButton onClick={retryReferences}>{t("common.retry")}</TextButton>
        </p>
      )}

      {!request ? (
        <StateMessage className="flex-1" title={t("comparison.chooseRevisions")} />
      ) : error ? (
        <StateMessage
          className="flex-1"
          tone="error"
          title={t("comparison.failed")}
          description={error}
          action={<TextButton onClick={retry}>{t("common.retry")}</TextButton>}
        />
      ) : !comparison ? (
        <StateMessage className="flex-1" tone="loading" title={t("comparison.loading")} />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1 text-xs text-text-secondary">
            <p title={summary(comparison)} className="selectable flex-1">
              {summary(comparison, 8)}
            </p>
            {comparison.files.length > 0 && <DiffLayoutControls {...layout} />}
          </div>

          <ComparisonFiles
            comparison={comparison}
            repositoryId={repositoryId}
            layout={layout.mode}
          />
        </>
      )}
    </section>
  );
}
