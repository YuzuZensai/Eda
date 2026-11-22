import { errorMessage } from "@shared/errors";
import { useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "../../../motion";

export type LayoutMotionKind = "layout" | "drawer";
export type EntryMotion = "forward" | "back" | "section";
type ViewMotion = EntryMotion | LayoutMotionKind;

const traceNavigation = import.meta.env.DEV && import.meta.env["VITE_EDA_TRACE_NAVIGATION"] === "1";

type RunningTransition = { transition: globalThis.ViewTransition; cleanup: () => void };

let running: RunningTransition | undefined;
let updating = false;

export function hasActiveViewTransition(): boolean {
  return running !== undefined;
}

export function afterViewTransition(effect: () => void): void {
  const job = running;

  if (!job) {
    effect();
    return;
  }

  void job.transition.finished
    .catch(() => {})
    .then(() => {
      if (running && running !== job) afterViewTransition(effect);
      else effect();
    });
}

export function animateViewEntry(element: HTMLElement, motion: EntryMotion) {
  if (prefersReducedMotion()) return;

  element.dataset["navigationFallback"] = motion;

  const animation = element
    .getAnimations?.()
    .find((item) => "animationName" in item && item.animationName === "ui-navigation-in");

  let active = true;

  const clear = () => {
    if (!active) return;
    active = false;
    delete element.dataset["navigationFallback"];
  };

  if (animation) {
    animation.currentTime = 0;
    animation.play();
    void animation.finished.then(clear, clear);
  } else clear();

  return clear;
}

export function useViewTransition() {
  const target = useRef<HTMLElement | null>(null);
  const fallbackCleanup = useRef<(() => void) | undefined>(undefined);

  const ref = useCallback((element: HTMLElement | null) => {
    fallbackCleanup.current?.();
    target.current = element;
  }, []);

  const transition = useCallback((update: () => void, motion: ViewMotion = "section") => {
    if (updating) {
      update();
      return;
    }

    running?.transition.skipTransition();
    running?.cleanup();
    running = undefined;
    fallbackCleanup.current?.();

    const element = target.current;

    if (!element || !document.startViewTransition || prefersReducedMotion()) {
      if (traceNavigation)
        console.info(
          "[Eda navigation] " +
            JSON.stringify({
              motion,
              skipped: !element
                ? "missing-region"
                : !document.startViewTransition
                  ? "unsupported"
                  : "reduced-motion",
            }),
        );

      update();

      return;
    }

    const started = performance.now();

    for (const region of [
      element,
      ...element.querySelectorAll<HTMLElement>("[data-navigation-fallback]"),
    ])
      delete region.dataset["navigationFallback"];

    let updateMs = 0;
    let readyAt: number | undefined;
    let captureError: string | undefined;
    let frameRequest = 0;
    let frames = 0;
    let longestFrameMs = 0;
    let lastFrameAt: number | undefined;
    let oldKeyframe: string | undefined;
    let newKeyframe: string | undefined;
    const transforms = new Set<string>();

    const layout = motion === "layout" || motion === "drawer";
    const regions = layout
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            motion === "drawer" ? ":scope > [data-layout-region]" : "[data-layout-region]",
          ),
        )
      : [element];

    const previousStyles = regions.map((region, index) => {
      const name = region.style.viewTransitionName;

      region.style.viewTransitionName = layout ? `layout-pane-${index}` : "navigation-content";

      return { region, name };
    });

    const oldSnapshot = layout
      ? "::view-transition-old(layout-pane-0)"
      : "::view-transition-old(navigation-content)";

    const newSnapshot = layout
      ? "::view-transition-new(layout-pane-0)"
      : "::view-transition-new(navigation-content)";

    document.documentElement.dataset["navigationMotion"] = motion;

    const cleanup = () => {
      for (const { region, name } of previousStyles) region.style.viewTransitionName = name;

      delete document.documentElement.dataset["navigationMotion"];
    };

    const native = document.startViewTransition(() => {
      const beforeUpdate = performance.now();
      updating = true;

      try {
        flushSync(update);
      } finally {
        updating = false;
      }

      updateMs = performance.now() - beforeUpdate;
    });

    const job = { transition: native, cleanup };

    running = job;

    void native.ready
      .then(() => {
        readyAt = performance.now();

        if (traceNavigation) {
          oldKeyframe = getComputedStyle(document.documentElement, oldSnapshot).animationName;
          newKeyframe = getComputedStyle(document.documentElement, newSnapshot).animationName;

          const sample = (now: number) => {
            if (running !== job) return;

            frames++;

            if (lastFrameAt !== undefined)
              longestFrameMs = Math.max(longestFrameMs, now - lastFrameAt);

            lastFrameAt = now;

            const style = getComputedStyle(document.documentElement, newSnapshot);

            transforms.add(style.transform + ":" + style.opacity);
            frameRequest = requestAnimationFrame(sample);
          };

          frameRequest = requestAnimationFrame(sample);
        }
      })
      .catch((error: unknown) => {
        captureError = errorMessage(error);

        if (running !== job || prefersReducedMotion() || layout) return;

        const destination = target.current;

        if (!destination) return;

        fallbackCleanup.current = animateViewEntry(destination, motion);
      });

    void native.finished
      .catch(() => {})
      .finally(() => {
        cancelAnimationFrame(frameRequest);

        if (traceNavigation) {
          console.info(
            "[Eda navigation] " +
              JSON.stringify({
                motion,
                updateMs: Math.round(updateMs),
                captureMs: readyAt === undefined ? null : Math.round(readyAt - started),
                animationMs: readyAt === undefined ? null : Math.round(performance.now() - readyAt),
                oldKeyframe,
                newKeyframe,
                frames,
                changingFrames: transforms.size,
                longestFrameMs: Math.round(longestFrameMs),
                superseded: running !== job,
                captureError: captureError ?? null,
                reducedMotion: prefersReducedMotion(),
              }),
          );
        }

        if (running !== job) return;

        cleanup();
        running = undefined;
      });
  }, []);

  return { ref, transition };
}
