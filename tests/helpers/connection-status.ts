import { act } from "react";
import { expect } from "vitest";

export async function checkConnectionStatusRetry(
  render: () => void,
  container: HTMLElement,
  button: (label: string) => HTMLButtonElement,
  signInLabel: string,
) {
  await act(async () => render());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector(".ui-skeleton")).toBeNull();
  await act(async () => button("Retry").click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button(signInLabel).disabled).toBe(false);
}
