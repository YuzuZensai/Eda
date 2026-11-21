import { isRecord } from "../validation";

export interface MergeTool {
  executable: string;
  args: string[];
}

export const defaultMergeTool = (): MergeTool => ({
  executable: "",
  args: ["{base}", "{current}", "{incoming}", "{result}"],
});

export const defaultDiffArgs = ["{before}", "{after}"];

export function isMergeTool(value: unknown): value is MergeTool {
  return isTool(value, ["base", "current", "incoming", "result"]);
}

export function isDiffTool(value: unknown): value is MergeTool {
  return isTool(value, ["before", "after"]);
}

function isTool(value: unknown, tokens: string[]): value is MergeTool {
  if (!isRecord(value)) return false;

  const item = value;
  const args: unknown = item["args"];

  return (
    Object.keys(item).every((key) => key === "executable" || key === "args") &&
    typeof item["executable"] === "string" &&
    (item["executable"] === "" ||
      (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(item["executable"]) &&
        item["executable"].length <= 4096 &&
        !/[\x00-\x1f]/.test(item["executable"]))) &&
    Array.isArray(args) &&
    args.length > 0 &&
    args.length <= 32 &&
    args.every(
      (arg) =>
        typeof arg === "string" &&
        arg.length <= 4096 &&
        !/[\0\r\n]/.test(arg) &&
        ![...arg.matchAll(/\{([^}]*)\}/g)].some((match) => !tokens.includes(match[1]!)),
    ) &&
    tokens.every((key) =>
      args.some((arg: unknown) => typeof arg === "string" && arg.includes(`{${key}}`)),
    )
  );
}

export interface DetectedMergeTool extends MergeTool {
  name: string;
}
