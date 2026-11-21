export type ConflictSide = "current" | "incoming";
export type LineSelection = Record<ConflictSide, boolean[]>;

export interface ConflictBlock {
  original: string;
  base: string;
  labels: Record<ConflictSide, string>;
  current: string[];
  incoming: string[];
  selection: LineSelection | null;
}

export type ConflictText = (string | ConflictBlock)[];

export function readConflictText(text: string, markerSize: number): ConflictText {
  const parts: ConflictText = [];
  const markers = new RegExp(
    `^(<{${markerSize}}|\\|{${markerSize}}|={${markerSize}}|>{${markerSize}})(?: ([^\\r\\n]*))?\\r?(?:\\n|$)`,
    "gm",
  );
  let start: RegExpExecArray | null = null;
  let base: RegExpExecArray | null = null;
  let divider: RegExpExecArray | null = null;
  let cursor = 0;

  for (const marker of text.matchAll(markers)) {
    const kind = marker[0][0];
    if (kind === "<") {
      start = marker;
      base = null;
      divider = null;
    } else if (start && kind === "|" && !divider && !base) {
      base = marker;
    } else if (start && kind === "=" && !divider) {
      divider = marker;
    } else if (start && divider && kind === ">") {
      const end = marker.index + marker[0].length;
      if (cursor < start.index) parts.push(text.slice(cursor, start.index));
      parts.push({
        original: text.slice(start.index, end),
        base: base ? text.slice(base.index + base[0].length, divider.index) : "",
        labels: { current: start[2] ?? "", incoming: marker[2] ?? "" },
        current: lines(text.slice(start.index + start[0].length, base?.index ?? divider.index)),
        incoming: lines(text.slice(divider.index + divider[0].length, marker.index)),
        selection: null,
      });
      cursor = end;
      start = null;
    } else {
      start = null;
    }
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

// Keep line terminators with their source so picking a line also preserves blank lines and CRLF.
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function blockOutput(block: ConflictBlock, keepMarkers: boolean): string {
  const selection = block.selection;
  if (!selection) return keepMarkers ? block.original : block.base;
  return (
    block.current.filter((_, index) => selection.current[index]).join("") +
    block.incoming.filter((_, index) => selection.incoming[index]).join("")
  );
}

export function conflictOutput(parts: ConflictText, keepMarkers: boolean): string {
  return parts
    .map((part) => (typeof part === "string" ? part : blockOutput(part, keepMarkers)))
    .join("");
}
