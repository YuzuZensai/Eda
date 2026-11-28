import type { Ref } from "react";
import { t } from "@shared/i18n";
import { ButtonBase } from "../../components/ui/index";
import { MAX_GRAPH_COLUMN_WIDTH, MIN_GRAPH_COLUMN_WIDTH } from "@shared/preferences/graph-view";
import type { useGraphColumns, ResizableColumn } from "./useGraphColumns";

export function GraphColumnHeader({
  graphColumns,
  disabled,
  gutter,
  shaHeader,
}: {
  graphColumns: ReturnType<typeof useGraphColumns>;
  disabled: boolean;
  gutter: number;
  shaHeader: Ref<HTMLSpanElement>;
}) {
  const {
    columns,
    headerRef,
    refsWidth,
    refsMaxWidth,
    startResize,
    saveWidth,
    moveColumn,
    startReorder,
    previewReorder,
    finishReorder,
    cancelReorder,
    dropTarget,
  } = graphColumns;
  const resizeHandle = (column: ResizableColumn) => {
    const rightEdge = column.id === "refs";
    const step = rightEdge ? 8 : -8;
    const maxWidth = rightEdge ? refsMaxWidth : MAX_GRAPH_COLUMN_WIDTH;

    return (
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={t("graphColumns.columnWidth", { id: column.id })}
        aria-valuemin={MIN_GRAPH_COLUMN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={column.width}
        aria-valuetext={t("graphColumns.px", { width: column.width })}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className={`absolute top-0 h-full w-2 touch-none cursor-col-resize rounded-sm border-border-default hover:border-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${rightEdge ? "right-0 border-r" : "-left-2 border-l"}`}
        onPointerDown={(event) => startResize(column, event)}
        onKeyDown={(event) => {
          let width: number;

          if (event.key === "ArrowLeft") width = column.width - step;
          else if (event.key === "ArrowRight") width = column.width + step;
          else if (event.key === "Home") width = MIN_GRAPH_COLUMN_WIDTH;
          else if (event.key === "End") width = maxWidth;
          else return;

          event.preventDefault();
          event.stopPropagation();
          saveWidth(column.id, width);
        }}
      />
    );
  };

  return (
    <div
      ref={headerRef}
      role="row"
      className="app-surface-chrome flex h-6 shrink-0 items-center border-b border-border-subtle bg-bg-surface text-xs font-medium uppercase tracking-wide text-text-tertiary"
    >
      <span className="history-ref-column relative h-full pr-2">
        {t("graphColumns.refs")}
        {resizeHandle({ id: "refs", width: refsWidth })}
      </span>
      <span className="shrink-0" style={{ width: gutter }} />

      <div className="flex min-w-0 flex-1 items-center gap-3 pr-3">
        <span className="min-w-0 flex-1 truncate">{t("commitGraph.commit")}</span>

        {columns
          .filter((column) => column.visible)
          .map((column) => (
            <span
              key={column.id}
              ref={column.id === "sha" ? shaHeader : undefined}
              style={{ width: column.width }}
              className="relative hidden shrink-0 @xl:block"
              onDragOver={(event) => previewReorder(column.id, event)}
              onDrop={(event) => finishReorder(column.id, event)}
            >
              <ButtonBase
                draggable={!disabled}
                disabled={disabled}
                aria-label={t("graphColumns.reorderColumn", { id: column.id })}
                aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                title={t("graphColumns.reorderHint")}
                className={`block w-full cursor-grab truncate rounded-sm text-left uppercase active:cursor-grabbing ${dropTarget === column.id ? "bg-accent-muted text-accent-text" : ""}`}
                onDragStart={(event) => startReorder(column.id, event)}
                onDragEnd={cancelReorder}
                onKeyDown={(event) => {
                  if (
                    !event.altKey ||
                    !event.shiftKey ||
                    !["ArrowLeft", "ArrowRight"].includes(event.key)
                  )
                    return;

                  event.preventDefault();
                  event.stopPropagation();
                  const visible = columns.filter((item) => item.visible);
                  const index = visible.findIndex((item) => item.id === column.id);
                  const target = visible[index + (event.key === "ArrowLeft" ? -1 : 1)];

                  if (target) moveColumn(column.id, target.id);
                }}
              >
                {t(`graphColumns.${column.id}`)}
              </ButtonBase>

              {resizeHandle(column)}
            </span>
          ))}
      </div>
    </div>
  );
}
