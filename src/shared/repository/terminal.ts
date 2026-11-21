import { isRecord } from "../validation";

export interface TerminalOptions {
  shell: string;
  font: string;
  size: number;
  cursor: "block" | "bar" | "underline";
  scrollback: number;
  completion: boolean;
  environment: Record<string, string>;
}
export const defaultTerminalOptions: TerminalOptions = {
  shell: "",
  font: "monospace",
  size: 13,
  cursor: "block",
  scrollback: 1000,
  completion: true,
  environment: {},
};
export function isTerminalOptions(v: unknown): v is TerminalOptions {
  if (!isRecord(v) || Object.keys(v).some((key) => !Object.hasOwn(defaultTerminalOptions, key)))
    return false;
  const bounded = (n: unknown, min: number, max: number) =>
    typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  return (
    typeof v["shell"] === "string" &&
    v["shell"].length <= 4096 &&
    !/[\x00-\x1f]/.test(v["shell"]) &&
    (!v["shell"] || /^(?:\/|[A-Za-z]:[\\/])/.test(v["shell"])) &&
    typeof v["font"] === "string" &&
    /^[\w ,.\-]{1,80}$/.test(v["font"]) &&
    bounded(v["size"], 9, 32) &&
    ["bar", "block", "underline"].includes(String(v["cursor"])) &&
    bounded(v["scrollback"], 100, 5000) &&
    typeof v["completion"] === "boolean" &&
    isRecord(v["environment"]) &&
    Object.entries(v["environment"]).every(
      ([key, value]) =>
        ["LANG", "LC_CTYPE", "TZ", "COLORTERM", "NO_COLOR"].includes(key) &&
        typeof value === "string" &&
        /^[\w./+:-]{0,100}$/.test(value),
    )
  );
}
export interface TerminalTab {
  id: string;
  title: string;
  exit: number | null;
}
export interface TerminalFrame {
  lines: string[];
  start: number;
  total: number;
  cursorX: number;
  cursorY: number;
  exit: number | null;
  revision: number;
  applicationCursor: boolean;
}
