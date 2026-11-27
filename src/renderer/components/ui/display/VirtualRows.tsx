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

function pixelAtRow(offsets: number[], position: number) {
  const index = Math.min(offsets.length - 1, Math.max(0, Math.floor(position)));
  const top = offsets[index]!;
  return top + Math.max(0, position - index) * ((offsets[index + 1] ?? top) - top);
}

function revealRange(element: HTMLDivElement, top: number, bottom: number) {
  if (top < element.scrollTop) element.scrollTop = top;
  else if (bottom > element.scrollTop + element.clientHeight)
    element.scrollTop = Math.min(top, bottom - element.clientHeight);
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
  measurementKey,
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
  measurementKey?: number;
  revealIndex?: number | undefined;
  revealKey?: string | number | undefined;
  scrollKey?: string | undefined;
  ariaLabel?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const lastViewport = useRef<{ key: typeof scrollKey; origin: number; top: number } | null>(null);
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
  // Keep paginated history anchored by row and fractional position as measured heights change.
  const pageOffsets = buffered ? offsets : null;
  const localTop = viewport.scrollTop - origin;
  const scrollTop = Math.max(
    0,
    Math.min(
      pageOffsets ? pixelAtRow(pageOffsets, localTop / rowHeight) : localTop,
      contentHeight - viewport.height,
    ),
  );
  const first = offsets ? firstVisibleRow(offsets, scrollTop) : 0;
  const last = offsets ? firstVisibleRow(offsets, scrollTop + viewport.height) : 0;
  const margin = Math.min(
    buffered ? 24 : 8,
    Math.max(0, Math.floor((MAX_RENDERED_ROWS - (last - first + 1)) / 2)),
  );
  const { start, end } = offsets
    ? {
        start: Math.max(0, first - margin),
        end: Math.min(items.length, last + margin + 1),
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
  const pinRenderedRows = buffered;
  const renderedBottom = offsets?.[renderEnd] ?? renderEnd * rowHeight;
  const minRowTop = Math.min(0, viewport.height - (renderedBottom - rowTop));
  const renderedTop = pinRenderedRows
    ? `clamp(${minRowTop}px, calc(${rowTop}px - var(--scroll-top, 0px)), 0px)`
    : `${rowTop}px`;

  useLayoutEffect(() => {
    setMeasurements((previous) => (previous.size ? new Map() : previous));
  }, [items, measureRows, measurementKey, rowHeight]);

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
  }, [measureRows, items, start, renderEnd, measurementKey, rowHeight]);

  const updateViewport = (element: HTMLDivElement) => {
    const top = element.scrollTop;
    lastViewport.current = { key: scrollKey, origin, top };
    if (pinRenderedRows) mounted.current?.style.setProperty("--scroll-top", `${top}px`);
    const height = element.clientHeight;
    lastScroll.current = top + origin;
    if (pageOffsets) {
      const index = firstVisibleRow(pageOffsets, top);
      const height = (pageOffsets[index + 1] ?? pageOffsets[index]!) - pageOffsets[index]!;
      const fraction = height > 0 ? (top - pageOffsets[index]!) / height : 0;
      lastScroll.current = origin + (index + fraction) * rowHeight;
    }
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

    const local = Math.max(0, lastScroll.current - origin);
    const previous = lastViewport.current;
    const pendingScroll =
      pageOffsets &&
      previous &&
      previous.key === scrollKey &&
      previous.origin === origin &&
      element.scrollTop !== previous.top;
    if (!pendingScroll) {
      element.scrollTop = pageOffsets ? pixelAtRow(pageOffsets, local / rowHeight) : local;
    }
    readViewport(element);
  }, [origin, scrollKey, pinRenderedRows, pageOffsets, rowHeight]);

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

    revealRange(element, top, bottom);
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
      onFocus={(event) => {
        const element = event.currentTarget;
        if (!pinRenderedRows || !mounted.current?.contains(event.target)) return;
        const bounds = event.target.getBoundingClientRect();
        const top = rowTop + bounds.top - mounted.current.getBoundingClientRect().top;
        revealRange(element, top, top + bounds.height);
        updateViewport(element);
      }}
    >
      <div
        className="relative min-w-full"
        style={{
          height: contentHeight,
          width: horizontalScroll ? "max-content" : "100%",
        }}
      >
        {/* A pinned viewport keeps the previous rows painted until the scroll handler runs. */}
        <div
          className={pinRenderedRows ? "sticky top-0 overflow-clip" : "contents"}
          style={pinRenderedRows ? { height: Math.min(viewport.height, contentHeight) } : undefined}
        >
          <div
            ref={mounted}
            className={pinRenderedRows ? undefined : "absolute left-0 top-0 min-w-full"}
            style={{
              transform: `translateY(${renderedTop})`,
              width: horizontalScroll ? undefined : "100%",
            }}
          >
            {items.slice(start, renderEnd).map((item, offset) => {
              const index = start + offset;
              return measureRows ? (
                <div key={itemOffset + index} data-row-index={index}>
                  {renderRow(item, itemOffset + index)}
                </div>
              ) : (
                renderRow(item, itemOffset + index)
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
