import { act } from "react";
import { createRoot } from "react-dom/client";
import { CommitPrefixPicker } from "@renderer/components/ui/forms/CommitPrefixPicker";

it("moves focus through visible prefix options and restores the trigger on Escape", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <CommitPrefixPicker
          value=""
          prefixes={["feat", "fix"]}
          disabled={false}
          onChange={vi.fn()}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(search);
    const key = async (value: string) => {
      await act(async () =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: value, bubbles: true }),
        ),
      );
    };
    await key("ArrowDown");
    expect(document.activeElement?.getAttribute("data-eda-select-value")).toBe("feat");
    await key("ArrowDown");
    expect(document.activeElement?.getAttribute("data-eda-select-value")).toBe("fix");
    await key("ArrowDown");
    expect(document.activeElement?.getAttribute("data-eda-select-value")).toBe("");
    await key("ArrowDown");
    expect(document.activeElement).toBe(search);
    await key("ArrowUp");
    expect(document.activeElement?.getAttribute("data-eda-select-value")).toBe("");
    await key("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
