import {
  Activity,
  createElement,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type Ref,
  type ReactNode,
} from "react";
import { LayoutMotion } from "./hooks/useLayoutTransition";
import {
  hasActiveViewTransition,
  animateViewEntry,
  useViewTransition,
  type EntryMotion,
  type LayoutMotionKind,
} from "./hooks/useViewTransition";
import { prefersReducedMotion } from "../../motion";

export function ViewTransition({
  as: Element = "div",
  ref,
  viewKey,
  motion = "section",
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "div" | "main" | "section";
  ref?: Ref<HTMLElement>;
  viewKey?: string;
  motion?: EntryMotion;
}) {
  const element = useRef<HTMLElement | null>(null);
  const previous = useRef(viewKey);

  useImperativeHandle(ref, () => element.current!, [Element]);

  useLayoutEffect(() => {
    if (previous.current === viewKey) return;
    previous.current = viewKey;

    const target = element.current;

    if (!target || hasActiveViewTransition() || prefersReducedMotion()) return;
    if (target.parentElement?.closest("[data-navigation-fallback]")) return;

    return animateViewEntry(target, motion);
  }, [viewKey, motion]);

  return createElement(Element, { ...props, ref: element });
}

export function LayoutTransition({ children, ...props }: HTMLAttributes<HTMLElement>) {
  const { ref, transition } = useViewTransition();
  const update = useCallback(
    (work: () => void, motion: LayoutMotionKind = "layout") => transition(work, motion),
    [transition],
  );

  return (
    <LayoutMotion value={update}>
      <ViewTransition {...props} ref={ref}>
        {children}
      </ViewTransition>
    </LayoutMotion>
  );
}

export function RetainedView({ active, children }: { active: boolean; children: ReactNode }) {
  return <Activity mode={active ? "visible" : "hidden"}>{children}</Activity>;
}
