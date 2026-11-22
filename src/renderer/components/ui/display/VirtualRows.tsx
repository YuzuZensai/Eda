import { t } from "@shared/i18n";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const MAX_RENDERED_ROWS = 80;
const PREFETCH_ROWS = 24;
const scrollPositions = new Map<string, number>();

export interface VirtualRange {
  start: number;
  end: number;
}

export function getVirtualRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8,
): VirtualRange {
  const visible = Math.min(MAX_RENDERED_ROWS, Math.ceil(viewportHeight / rowHeight));
  const margin = Math.min(overscan, Math.floor((MAX_RENDERED_ROWS - visible) / 2));
  const start = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - margin));
  const end = Math.min(count, start + visible + margin * 2);
  return { start, end };
}

function firstVisibleRow(offsets: number[], scrollTop: number) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= scrollTop) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function VirtualRows<T>({
  items,
  rowHeight,
  renderRow,
  className = "",
  onNearEnd,
  onNearStart,
  itemOffset = 0,
  horizontalScroll = true,
  buffered = false,
  measureRows = false,
  revealIndex,
  revealKey = revealIndex,
  scrollKey,
  ariaLabel = t("virtualRows.scrollableRows"),
}: {
  items: readonly T[];
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  className?: string;
  onNearEnd?: (() => void) | undefined;
  onNearStart?: (() => void) | undefined;
  itemOffset?: number;
  horizontalScroll?: boolean;
  buffered?: boolean;
  measureRows?: boolean;
  revealIndex?: number | undefined;
  revealKey?: string | number | undefined;
  scrollKey?: string | undefined;
  ariaLabel?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const restoredScroll = useRef(false);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 500 });
  const mounted = useRef<HTMLDivElement>(null);
  const origin = itemOffset * rowHeight;
  const [measurements, setMeasurements] = useState<ReadonlyMap<T, number>>(() => new Map());
  const offsets = useMemo(() => {
    if (!measureRows) return null;
    const result = [0];
    for (const item of items)
      result.push(result[result.length - 1]! + (measurements.get(item) ?? rowHeight));
    return result;
  }, [items, rowHeight, measurements, measureRows]);
  const contentHeight = offsets?.at(-1) ?? items.length * rowHeight;
  const scrollTop = Math.max(
    0,
    Math.min(viewport.scrollTop - origin, contentHeight - viewport.height),
  );
  const { start, end } = offsets
    ? {
        start: Math.max(0, firstVisibleRow(offsets, scrollTop) - 8),
        end: Math.min(items.length, firstVisibleRow(offsets, scrollTop + viewport.height) + 9),
      }
    : getVirtualRange(
        items.length,
        scrollTop,
        viewport.height + (buffered ? rowHeight * 7 : 0),
        rowHeight,
        buffered ? 24 : 8,
      );
  const renderEnd = Math.min(end, start + MAX_RENDERED_ROWS);
  const rowTop = offsets?.[start] ?? start * rowHeight;
  const pinRenderedRows = buffered && !offsets;
  const stickyInset = Math.min(0, viewport.height - (renderEnd - start) * rowHeight);

  useLayoutEffect(() => {
    if (!measureRows || !mounted.current) return;
    const observer = new ResizeObserver((entries) => {
      setMeasurements((previous) => {
        const next = new Map(previous);
        let changed = false;
        for (const entry of entries) {
          const index = Number(entry.target.getAttribute("data-row-index"));
          const item = items[index];
          const height = entry.contentRect.height;
          if (item !== undefined && height > 0 && next.get(item) !== height) {
            next.set(item, height);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    });
    for (const row of mounted.current.children) observer.observe(row);
    return () => observer.disconnect();
  }, [measureRows, items, start, renderEnd]);

  useEffect(() => {
    setMeasurements((previous) => (previous.size ? new Map() : previous));
  }, [items, measureRows]);

  const updateViewport = (element: HTMLDivElement) => {
    const top = element.scrollTop;
    const height = element.clientHeight;
    lastScroll.current = top + origin;
    const batch =
      buffered && height <= (MAX_RENDERED_ROWS - 8) * rowHeight ? rowHeight * 8 : rowHeight;
    const scrollTop = measureRows
      ? lastScroll.current
      : Math.floor(lastScroll.current / batch) * batch;
    setViewport((previous) =>
      previous.scrollTop === scrollTop && previous.height === height
        ? previous
        : { scrollTop, height },
    );
  };
  const readViewport = useEffectEvent(updateViewport);

  useLayoutEffect(() => {
    const element = container.current;

    if (!element) return;

    const savedPosition = scrollKey ? scrollPositions.get(scrollKey) : undefined;
    restoredScroll.current = savedPosition !== undefined;
    if (scrollKey) lastScroll.current = savedPosition ?? 0;

    const observer = new ResizeObserver(() => readViewport(element));
    observer.observe(element);

    return () => {
      observer.disconnect();
      if (scrollKey) {
        scrollPositions.delete(scrollKey);
        scrollPositions.set(scrollKey, lastScroll.current);
        if (scrollPositions.size > 64) scrollPositions.delete(scrollPositions.keys().next().value!);
      }
    };
  }, [scrollKey]);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;

    element.scrollTop = Math.max(0, lastScroll.current - origin);
    readViewport(element);
  }, [origin, scrollKey]);

  useEffect(() => {
    if (end >= items.length - PREFETCH_ROWS) onNearEnd?.();
    if (start <= PREFETCH_ROWS) onNearStart?.();
  }, [itemOffset, items.length, onNearEnd, onNearStart, end, start]);

  const reveal = useEffectEvent(() => {
    const element = container.current;

    if (restoredScroll.current) {
      restoredScroll.current = false;
      return;
    }

    if (!element || revealIndex === undefined || revealIndex < itemOffset) return;

    const index = revealIndex - itemOffset;
    const top = offsets?.[index] ?? index * rowHeight;
    const bottom = offsets?.[index + 1] ?? top + rowHeight;

    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.min(top, bottom - element.clientHeight);
  });
  useEffect(() => {
    reveal();
  }, [revealKey, rowHeight, measureRows]);

  return (
    <div
      ref={container}
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      data-virtual-list="true"
      data-retained-count={items.length}
      data-item-offset={itemOffset}
      className={`ui-scroll-region relative overflow-auto ${className}`}
      onScroll={(event) => updateViewport(event.currentTarget)}
    >
      <div
        className="relative min-w-full"
        style={{
          height: contentHeight,
          width: horizontalScroll ? "max-content" : "100%",
        }}
      >
        {pinRenderedRows && <div style={{ height: rowTop }} />}
        <div
          ref={mounted}
          className={pinRenderedRows ? "sticky min-w-full" : "absolute left-0 top-0 min-w-full"}
          style={{
            ...(pinRenderedRows
              ? { insetBlock: stickyInset }
              : { transform: `translateY(${rowTop}px)` }),
            width: horizontalScroll ? undefined : "100%",
          }}
        >
          {items.slice(start, renderEnd).map((item, offset) => {
            const index = start + offset;
            return measureRows ? (
              <div key={index} data-row-index={index}>
                {renderRow(item, index)}
              </div>
            ) : (
              renderRow(item, itemOffset + index)
            );
          })}
        </div>
      </div>
    </div>
  );
}
