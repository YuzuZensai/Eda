import { fillInput } from "../../../helpers/form-controls";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Select } from "@renderer/components/ui/forms/FormControls";
import { RadioCard } from "@renderer/components/ui/forms/RadioCard";
import { RangeField } from "@renderer/components/ui/forms/RangeField";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps radio-card Home and End selection inside its own group", async () => {
  function Example() {
    const [value, setValue] = useState("middle");

    return (
      <>
        <div role="radiogroup" aria-label="Layout">
          {["first", "middle", "last"].map((option) => (
            <RadioCard
              key={option}
              name="layout"
              value={option}
              checked={value === option}
              onChange={setValue}
            >
              {option}
            </RadioCard>
          ))}
        </div>
        <div role="radiogroup" aria-label="Other layout">
          <RadioCard name="other-layout" value="other" checked onChange={() => {}}>
            Other
          </RadioCard>
        </div>
      </>
    );
  }

  await act(async () => root.render(<Example />));

  const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');

  await act(async () => {
    radios[1]!.focus();
    radios[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  });
  expect(radios[2]!.checked).toBe(true);
  expect(document.activeElement).toBe(radios[2]);

  await act(async () => {
    radios[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  });
  expect(radios[0]!.checked).toBe(true);
  expect(document.activeElement).toBe(radios[0]);
  expect(radios[3]!.checked).toBe(true);
});

it("opens from the keyboard, restores on Escape, and selects a choice", async () => {
  function Example() {
    const [value, setValue] = useState("first");

    return (
      <Select aria-label="Example" value={value} onValueChange={setValue}>
        <option value="first">First choice</option>
        <option value="second">Second choice</option>
      </Select>
    );
  }

  await act(async () => root.render(<Example />));

  const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;

  expect(trigger.textContent).toContain("First choice");

  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  expect(trigger.textContent).toContain("First choice");

  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await act(async () => {
    document.querySelectorAll<HTMLElement>('[role="option"]')[1]?.click();
  });
  expect(trigger.textContent).toContain("Second choice");
});

it("does not let an old slider failure replace a newer value or interaction", async () => {
  const pending: Array<(saved: boolean) => void> = [];
  const onCommit = vi.fn(() => new Promise<boolean>((resolve) => pending.push(resolve)));
  const render = async (value: number) =>
    act(async () => root.render(<RangeField label="Opacity" value={value} onCommit={onCommit} />));
  await render(20);
  const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
  const change = async (value: number) => fillInput(slider, String(value));
  const commit = async () =>
    act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
    });

  await change(40);
  await commit();
  await render(60);
  await act(async () => pending[0]!(false));
  expect(slider.value).toBe("60");

  await change(70);
  await commit();
  await change(80);
  await act(async () => pending[1]!(false));
  expect(slider.value).toBe("80");
  await commit();
  expect(onCommit).toHaveBeenLastCalledWith(80);
  await act(async () => pending[2]!(false));
  expect(slider.value).toBe("60");
});
