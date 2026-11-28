import { expect } from "vitest";
import { act } from "react";

export function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  // Use the native setter so React observes the change when the input event bubbles.
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function fillInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => setInputValue(input, value));
}

export async function chooseOption(control: HTMLElement, label: string) {
  await act(async () =>
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === label,
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
}
