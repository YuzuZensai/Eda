import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  MAX_RENDERED_ROWS,
  getVirtualRange,
  VirtualRows,
} from "@renderer/components/ui/display/VirtualRows";

describe("virtual row bounds", () => {
  it("clamps both ends", () => {
    expect(getVirtualRange(4, 0, 100, 20)).toEqual({ start: 0, end: 4 });
    expect(getVirtualRange(4, 10_000, 100, 20)).toEqual({ start: 4, end: 4 });
  });

  it("keeps tall viewports filled when overscan would exceed the row budget", () => {
    const rowHeight = 24;
    const range = getVirtualRange(1_000, 50 * rowHeight, 60 * rowHeight, rowHeight, 24);
    expect(range.start).toBeLessThanOrEqual(50);
    expect(range.end).toBeGreaterThanOrEqual(110);
    expect(range.end - range.start).toBeLessThanOrEqual(MAX_RENDERED_ROWS);
  });

  it("never exceeds the cap even when the viewport is taller than it", () => {
    const range = getVirtualRange(1_000_000, 6_000, 4_000, 30);
    expect(range.end - range.start).toBe(MAX_RENDERED_ROWS);
  });
});

it("anchors visible rows as the retained window moves in either direction", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renderRow = (item: string, index: number) =>
    createElement("div", { key: item, "data-row": index }, item);
  const render = (itemOffset: number, revealIndex?: number, revealKey = "commit-30") =>
    act(async () =>
      root.render(
        createElement(VirtualRows<string>, {
          items: Array.from({ length: 100 }, (_, index) => `commit-${index + itemOffset}`),
          itemOffset,
          rowHeight: 20,
          revealIndex,
          revealKey,
          renderRow,
        }),
      ),
    );

  try {
    await render(50);
    const region = container.querySelector<HTMLElement>('[role="region"]')!;
    expect(container.querySelector("[data-row]")?.textContent).toBe("commit-50");

    await act(async () => {
      region.scrollTop = 10 * 20;
      region.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const anchor = container.querySelector('[data-row="60"]');
    expect(anchor?.textContent).toBe("commit-60");

    await render(25, 30);
    expect(region.scrollTop).toBe(35 * 20);
    expect(container.querySelector('[data-row="60"]')).toBe(anchor);

    await render(55);
    expect(region.scrollTop).toBe(5 * 20);
    expect(container.querySelector('[data-row="60"]')).toBe(anchor);

    await render(55, 55, "commit-55");
    expect(region.scrollTop).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
