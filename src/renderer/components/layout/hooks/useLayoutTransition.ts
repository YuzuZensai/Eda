import { createContext, useContext } from "react";
import type { LayoutMotionKind } from "./useViewTransition";

export const LayoutMotion = createContext<(update: () => void, motion?: LayoutMotionKind) => void>(
  (update) => update(),
);

export function useLayoutTransition() {
  return useContext(LayoutMotion);
}
