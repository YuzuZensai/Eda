import { useEffect, useId, useRef, useState } from "react";
import { t } from "@shared/i18n";
import { Button, CheckboxControl, Textarea } from "../../components/ui/index";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { cx } from "../../components/ui/cx";
import { revisionLabel } from "../../repository/reference-label";
import { useRepositoryStore } from "../../stores/repository-store";
import {
  conflictOutput,
  readConflictText,
  type ConflictSide,
  type ConflictText,
  type LineSelection,
} from "./conflict-text";

export function ConflictBlockEditor({
  parts,
  onChange,
  markerSize,
  busy,
  markers,
  sides,
  branch,
}: {
  parts: ConflictText;
  onChange: (value: ConflictText) => void;
  markerSize: number;
  busy: boolean;
  markers: boolean;
  sides: Record<ConflictSide, string>;
  branch: string | undefined;
}) {
  const editorId = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  const blocks = parts.filter((part) => typeof part !== "string");
  const [position, setPosition] = useState(() =>
    Math.max(
      0,
      blocks.findIndex((part) => !part.selection),
    ),
  );
  const [manual, setManual] = useState(false);
  const [undo, setUndo] = useState<{ parts: ConflictText; position: number } | null>(null);
  const index = Math.min(position, Math.max(0, blocks.length - 1));
  const block = blocks[index];
  const undecided = blocks.some((part) => !part.selection);
  const showMarkers = manual || !undecided;
  const incoming = useRepositoryStore((state) =>
    revisionLabel(state.pages, block?.labels.incoming ?? ""),
  );
  const labels = {
    current: block?.labels.current === "HEAD" ? branch : block?.labels.current,
    incoming,
  };

  useEffect(() => {
    const field = editor.current;
    if (!field || !block) return;
    const before = conflictOutput(parts.slice(0, parts.indexOf(block)), showMarkers);
    const line = before.split("\n").length - 1;
    field.scrollTop = line * parseFloat(getComputedStyle(field).lineHeight);
    if (manual) {
      const offset = before.replaceAll("\r\n", "\n").length;
      field.setSelectionRange(offset, offset);
      field.focus({ preventScroll: true });
    }
  }, [index, manual]);

  const choose = (selection: LineSelection | null, advance: boolean) => {
    if (!block) return;
    setUndo({ parts, position: index });
    onChange(parts.map((part) => (part === block ? { ...block, selection } : part)));
    if (advance) {
      const next = blocks.findIndex((part, i) => i > index && !part.selection);
      const first = blocks.findIndex((part, i) => i < index && !part.selection);
      if (next >= 0 || first >= 0) setPosition(next >= 0 ? next : first);
    }
  };

  const chooseSide = (side: ConflictSide | "both") => {
    if (!block) return;
    choose(
      {
        current: block.current.map(() => side !== "incoming"),
        incoming: block.incoming.map(() => side !== "current"),
      },
      true,
    );
  };

  const toggle = (side: ConflictSide, line: number) => {
    if (!block) return;
    const selected = block.selection ?? { current: [], incoming: [] };
    const picked = [...selected[side]];
    picked[line] = !picked[line];
    const next = { ...selected, [side]: picked };
    choose(next.current.some(Boolean) || next.incoming.some(Boolean) ? next : null, false);
  };

  return (
    <>
      {block && (
        <section
          className="flex min-h-32 flex-1 flex-col gap-2"
          aria-label={t("conflicts.compareChanges")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold" aria-live="polite">
              {t("conflicts.blockPosition", { position: index + 1, total: blocks.length })}
            </h3>

            {blocks.length > 1 && (
              <>
                <Button
                  size="sm"
                  disabled={busy || index === 0}
                  onClick={() => setPosition(index - 1)}
                >
                  {t("conflicts.previous")}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || index + 1 >= blocks.length}
                  onClick={() => setPosition(index + 1)}
                >
                  {t("common.next")}
                </Button>
              </>
            )}
            <Button size="sm" disabled={busy} onClick={() => chooseSide("both")}>
              {t("conflicts.useBoth")}
            </Button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border-subtle overflow-hidden rounded border border-border-subtle bg-bg-inset">
            {(["current", "incoming"] as const).map((side) => (
              <section key={side} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-bg-surface px-3 py-1">
                  <h4 className="flex min-w-0 items-baseline gap-2 whitespace-nowrap text-xs font-semibold">
                    <span className="truncate" title={sides[side]}>
                      {sides[side]}
                    </span>
                    {labels[side] && (
                      <span
                        title={labels[side]}
                        className="truncate font-mono font-normal text-text-secondary"
                      >
                        {labels[side]}
                      </span>
                    )}
                  </h4>
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={busy}
                    aria-label={t("conflicts.use", { value1: sides[side].toLowerCase() })}
                    onClick={() => chooseSide(side)}
                  >
                    {t(side === "current" ? "conflicts.useCurrent" : "conflicts.useIncoming")}
                  </Button>
                </div>
                {block[side].length > 0 ? (
                  <VirtualRows
                    key={index}
                    ariaLabel={sides[side]}
                    items={block[side]}
                    rowHeight={24}
                    className="min-h-0 flex-1 font-mono text-xs"
                    renderRow={(text, line) => (
                      <label
                        key={line}
                        className={cx(
                          "flex h-6 cursor-pointer items-center gap-2 px-3 hover:bg-bg-raised focus-within:bg-bg-raised",
                          block.selection?.[side][line] &&
                            (side === "current" ? "bg-accent-muted" : "bg-git-modified/15"),
                        )}
                      >
                        <CheckboxControl
                          disabled={busy}
                          checked={!!block.selection?.[side][line]}
                          aria-label={t("conflicts.includeLine", {
                            side: sides[side],
                            line: line + 1,
                          })}
                          aria-description={text.trimEnd()}
                          onChange={() => toggle(side, line)}
                        />
                        <span
                          aria-hidden="true"
                          className="min-w-4 select-none text-right text-text-tertiary"
                        >
                          {line + 1}
                        </span>
                        <code className="whitespace-pre">{text.replace(/\r?\n$/, "")}</code>
                      </label>
                    )}
                  />
                ) : (
                  <p className="p-3 text-xs text-text-secondary">{t("conflicts.emptySide")}</p>
                )}
              </section>
            ))}
          </div>
        </section>
      )}

      <div className="flex min-h-32 flex-[1.3] flex-col gap-1 text-xs">
        <div className="flex min-h-7 items-center gap-2">
          <label htmlFor={editorId} className="font-semibold">
            {t("conflicts.resolvedOutput")}
          </label>
          {block && (
            <span className="mr-auto text-text-secondary" role="status">
              {t("conflicts.chosenChanges", {
                chosen: blocks.filter((part) => part.selection).length,
                total: blocks.length,
              })}
            </span>
          )}
          {undo && (
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() => {
                onChange(undo.parts);
                setPosition(undo.position);
                setUndo(null);
              }}
            >
              {t("conflicts.undoChoice")}
            </Button>
          )}
          {undecided && (
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              aria-pressed={manual}
              onClick={() => setManual(!manual)}
            >
              {t(manual ? "conflicts.showPreview" : "conflicts.editMarkers")}
            </Button>
          )}
        </div>

        <Textarea
          id={editorId}
          ref={editor}
          wrap="off"
          spellCheck={false}
          disabled={busy}
          readOnly={!showMarkers}
          value={conflictOutput(parts, showMarkers)}
          placeholder={undecided ? t("conflicts.chooseLines") : undefined}
          onChange={(event) => {
            setUndo(null);
            onChange(readConflictText(event.target.value, markerSize));
          }}
          surface="base"
          className="min-h-24 flex-1 resize-none font-mono"
        />
      </div>

      {markers && (showMarkers || !block) && (
        <p className="text-xs text-git-modified">{t("conflicts.markersRemain")}</p>
      )}
    </>
  );
}
