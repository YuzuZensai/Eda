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
  const visible = Math.ceil(viewportHeight / rowHeight);
  const start = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = Math.min(count, start + Math.min(MAX_RENDERED_ROWS, visible + overscan * 2));
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
  totalCount = items.length,
  horizontalScroll = true,
  measureRows = false,
  revealIndex,
  scrollKey,
  ariaLabel = t("virtualRows.scrollableRows"),
}: {
  items: readonly T[];
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  className?: string;
  onNearEnd?: () => void;
  onNearStart?: () => void;
  itemOffset?: number;
  totalCount?: number;
  horizontalScroll?: boolean;
  measureRows?: boolean;
  revealIndex?: number | undefined;
  scrollKey?: string | undefined;
  ariaLabel?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const restoredScroll = useRef(false);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 500 });
  const mounted = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState<ReadonlyMap<T, number>>(() => new Map());
  const offsets = useMemo(() => {
    if (!measureRows) return null;
    const result = [0];
    for (const item of items)
      result.push(result[result.length - 1]! + (measurements.get(item) ?? rowHeight));
    return result;
  }, [items, rowHeight, measurements, measureRows]);
  const range = offsets
    ? {
        start: Math.max(0, firstVisibleRow(offsets, viewport.scrollTop) - 8),
        end: Math.min(
          items.length,
          firstVisibleRow(offsets, viewport.scrollTop + viewport.height) + 9,
        ),
      }
    : getVirtualRange(totalCount, viewport.scrollTop, viewport.height, rowHeight);
  const retainedStart = Math.min(itemOffset + items.length, Math.max(range.start, itemOffset));
  const retainedEnd = Math.max(
    retainedStart,
    Math.min(range.end, retainedStart + MAX_RENDERED_ROWS, itemOffset + items.length),
  );

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
  }, [measureRows, items, retainedStart, retainedEnd]);

  useEffect(() => {
    setMeasurements((previous) => (previous.size ? new Map() : previous));
  }, [items, measureRows]);

  useEffect(() => {
    const element = container.current;

    if (!element) return;

    restoredScroll.current = !!scrollKey && scrollPositions.has(scrollKey);

    if (scrollKey) element.scrollTop = scrollPositions.get(scrollKey) ?? 0;

    lastScroll.current = element.scrollTop;

    const update = () =>
      setViewport({ scrollTop: element.scrollTop, height: element.clientHeight });

    update();

    const observer = new ResizeObserver(update);

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

  useEffect(() => {
    if (range.end >= itemOffset + items.length - 8) onNearEnd?.();
    if (range.start <= itemOffset + 8) onNearStart?.();
  }, [itemOffset, items.length, onNearEnd, onNearStart, range.end, range.start]);

  const reveal = useEffectEvent(() => {
    const element = container.current;

    if (restoredScroll.current) {
      restoredScroll.current = false;
      return;
    }

    if (!element || revealIndex === undefined || revealIndex < 0) return;

    const top = offsets?.[revealIndex] ?? revealIndex * rowHeight;
    const bottom = offsets?.[revealIndex + 1] ?? top + rowHeight;

    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.min(top, bottom - element.clientHeight);
  });
  useEffect(() => {
    reveal();
  }, [revealIndex, rowHeight, measureRows]);

  return (
    <div
      ref={container}
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      data-virtual-list="true"
      data-mounted-count={Math.max(0, retainedEnd - retainedStart)}
      data-retained-count={items.length}
      data-total-count={totalCount}
      data-item-offset={itemOffset}
      className={`ui-scroll-region relative overflow-auto ${className}`}
      onScroll={(event) => {
        lastScroll.current = event.currentTarget.scrollTop;
        setViewport({
          scrollTop: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight,
        });
      }}
    >
      <div
        className="relative min-w-full"
        style={{
          height: offsets?.at(-1) ?? totalCount * rowHeight,
          width: horizontalScroll ? "max-content" : "100%",
        }}
      >
        <div
          ref={mounted}
          className="absolute left-0 top-0 min-w-full"
          style={{
            transform: `translateY(${offsets?.[retainedStart] ?? retainedStart * rowHeight}px)`,
            ...(horizontalScroll ? {} : { width: "100%" }),
          }}
        >
          {items.slice(retainedStart - itemOffset, retainedEnd - itemOffset).map((item, offset) => {
            const index = retainedStart + offset;
            return measureRows ? (
              <div key={index} data-row-index={index}>
                {renderRow(item, index)}
              </div>
            ) : (
              renderRow(item, index)
            );
          })}
        </div>
      </div>
    </div>
  );
}
