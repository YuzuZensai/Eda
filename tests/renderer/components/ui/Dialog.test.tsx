import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorDialog } from "@renderer/components/ui/overlays/ErrorDialog";
import { Dialog } from "@renderer/components/ui/overlays/Dialog";
import { DialogActions } from "@renderer/components/ui/actions/DialogActions";

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

it("focuses the dialog, dismisses on Escape, and restores the opener", async () => {
  function Example() {
    const [open, setOpen] = useState(false);

    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>

        {open && (
          <Dialog title="Example" description="A dialog" onClose={() => setOpen(false)}>
            <button>Action</button>
          </Dialog>
        )}
      </>
    );
  }

  await act(async () => root.render(<Example />));

  const opener = container.querySelector("button")!;

  await act(async () => {
    opener.focus();
    opener.click();
  });

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;

  expect(dialog).toBeTruthy();
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(dialog.getAttribute("aria-describedby")).toBeTruthy();

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

  expect(document.querySelector('[role="dialog"]')).toBeNull();

  await vi.waitFor(() => expect(document.activeElement).toBe(opener), { timeout: 500 });
});

it("dismisses an operation error without closing its form and presents a subsequent failure", async () => {
  function Example() {
    const [error, setError] = useState<string | null>(null);

    return (
      <Dialog title="Edit settings" onClose={() => {}}>
        <input defaultValue="Keep this draft" />
        <button onClick={() => setError("Could not save")}>Save</button>
        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </Dialog>
    );
  }

  await act(async () => root.render(<Example />));

  const save = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Save",
  )!;

  for (let attempt = 0; attempt < 2; attempt++) {
    await act(async () => save.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not save");

    const dismiss = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Dismiss",
    )!;

    await act(async () => dismiss.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector("input")?.value).toBe("Keep this draft");
  }
});

it("keeps a busy dialog open and focused until its action finishes", async () => {
  const close = vi.fn();
  const confirm = vi.fn();

  const render = (busy: boolean) => (
    <Dialog
      title="Save changes"
      onClose={close}
      busy={busy}
      footer={<DialogActions busy={busy} onClose={close} onConfirm={confirm} confirmLabel="Save" />}
    >
      <input aria-label="Name" defaultValue="Draft" />
    </Dialog>
  );

  await act(async () => root.render(render(true)));

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const input = dialog.querySelector("input")!;
  const buttons = [...dialog.querySelectorAll("button")];

  expect(buttons.every((button) => button.disabled)).toBe(true);

  expect(buttons.find((button) => button.textContent === "Save")?.getAttribute("aria-busy")).toBe(
    "true",
  );

  await act(async () => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (const button of buttons) button.click();
  });

  expect(close).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);

  await act(async () => root.render(render(false)));
  expect(buttons.every((button) => !button.disabled)).toBe(true);

  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  expect(close).toHaveBeenCalledOnce();
});
