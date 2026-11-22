import { useEffect, useRef, type RefObject } from "react";

const MENU = '[role="menu"]';

function parentMenu(menu: Element): Element | null {
  const id = menu.getAttribute("aria-labelledby");
  const trigger = id && document.getElementById(id);

  return trigger && trigger.getAttribute("aria-controls") === menu.id
    ? trigger.closest(MENU)
    : null;
}

function isInMenuTree(menu: HTMLElement, target: Element): boolean {
  for (let current = target.closest(MENU); current; current = parentMenu(current)) {
    if (current === menu) return true;
  }

  return menu.contains(target);
}

export function useMenuKeyboard(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
  returnFocusRef?: RefObject<HTMLElement | null>,
  triggerRef?: RefObject<HTMLElement | null>,
  autoFocus = true,
): void {
  const dismiss = useRef(onDismiss);

  dismiss.current = onDismiss;

  useEffect(() => {
    if (!active) return;

    const opener =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    const items = () =>
      Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).filter(
        (item) => !item.matches(":disabled, [aria-disabled='true']"),
      );

    if (autoFocus) items()[0]?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const menu = ref.current;
      const target = event.target;

      if (
        menu &&
        target instanceof Element &&
        !isInMenuTree(menu, target) &&
        !(triggerRef ?? returnFocusRef)?.current?.contains(target)
      )
        dismiss.current();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const menu = ref.current;
      const target = event.target;
      if (!menu || !(target instanceof Element)) return;

      if (event.key === "Tab") {
        if (isInMenuTree(menu, target)) dismiss.current();
        return;
      }

      if (!menu.contains(target) || target.closest(MENU) !== menu) return;

      if (event.key === "Escape" || (event.key === "ArrowLeft" && parentMenu(menu))) {
        event.preventDefault();
        event.stopPropagation();
        dismiss.current();
        opener?.focus();
        return;
      }

      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

      const options = items();

      if (!options.length) return;

      event.preventDefault();

      const current = options.indexOf(document.activeElement as HTMLElement);

      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : current < 0
              ? event.key === "ArrowDown"
                ? 0
                : options.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;

      options[next]?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, { capture: true });

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [active, ref, returnFocusRef, triggerRef, autoFocus]);
}
