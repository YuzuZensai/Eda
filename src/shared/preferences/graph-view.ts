import { isFullObjectId } from "../repository/object-id";
import { isOneOf, isRecord } from "../validation";

export const GRAPH_COLUMN_IDS = ["author", "date", "sha"] as const;
// Saved layouts and visibility preferences may include the former standalone tags column.
export const SAVED_GRAPH_COLUMN_IDS = [...GRAPH_COLUMN_IDS, "tags"] as const;
export type GraphColumnId = (typeof GRAPH_COLUMN_IDS)[number];
export type SavedGraphColumnId = (typeof SAVED_GRAPH_COLUMN_IDS)[number];

export interface GraphFilter {
  refs: string[];
  hiddenRefs: string[];
  pinnedRef: string | null;
  pinnedOid?: string | undefined;
  showStashes?: boolean;
  showInternalRefs?: boolean | undefined;
}

export const defaultGraphFilter = (): GraphFilter => ({
  refs: [],
  hiddenRefs: [],
  pinnedRef: null,
  showStashes: true,
});

export function isGraphFilter(value: unknown): value is GraphFilter {
  if (!isRecord(value)) return false;

  const item = value;
  const ref = (name: unknown) =>
    typeof name === "string" &&
    /^refs\/(heads|remotes|tags)\//.test(name) &&
    name.length <= 255 &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(name) &&
    !name.includes("..");

  return (
    Object.keys(item).every((key) =>
      ["refs", "hiddenRefs", "pinnedRef", "pinnedOid", "showStashes", "showInternalRefs"].includes(
        key,
      ),
    ) &&
    (item["showStashes"] === undefined || typeof item["showStashes"] === "boolean") &&
    (item["showInternalRefs"] === undefined || typeof item["showInternalRefs"] === "boolean") &&
    [item["refs"], item["hiddenRefs"]].every(
      (list) => Array.isArray(list) && list.length <= 256 && list.every(ref),
    ) &&
    (item["pinnedRef"] === null || ref(item["pinnedRef"])) &&
    (item["pinnedOid"] === undefined || isFullObjectId(item["pinnedOid"]))
  );
}

export interface SavedGraphColumn {
  id: SavedGraphColumnId;
  visible: boolean;
  width: number;
}

export interface GraphColumn extends SavedGraphColumn {
  id: GraphColumnId;
}

export const defaultGraphColumns = (): GraphColumn[] => [
  { id: "author", visible: true, width: 96 },
  { id: "date", visible: true, width: 72 },
  { id: "sha", visible: true, width: 72 },
];

export function resolveGraphColumns(saved: SavedGraphColumn[] | undefined): GraphColumn[] {
  return (
    saved?.filter((column): column is GraphColumn => column.id !== "tags") ?? defaultGraphColumns()
  );
}

export function isGraphColumns(value: unknown): value is SavedGraphColumn[] {
  if (!Array.isArray(value) || value.length > SAVED_GRAPH_COLUMN_IDS.length) return false;

  const ids = new Set(value.map((item: unknown) => (isRecord(item) ? item["id"] : undefined)));
  const expectedCount = GRAPH_COLUMN_IDS.length + (ids.has("tags") ? 1 : 0);

  return (
    ids.size === expectedCount &&
    value.length === expectedCount &&
    value.every(
      (item: unknown) =>
        isRecord(item) &&
        isOneOf(item["id"], SAVED_GRAPH_COLUMN_IDS) &&
        typeof item["visible"] === "boolean" &&
        typeof item["width"] === "number" &&
        Number.isInteger(item["width"]) &&
        item["width"] >= 48 &&
        item["width"] <= 320 &&
        Object.keys(item).every((key) => ["id", "visible", "width"].includes(key)),
    )
  );
}
