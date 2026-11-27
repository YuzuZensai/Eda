import {
  isGraphColumns,
  isGraphFilter,
  type SavedGraphColumn,
  type GraphFilter,
} from "../preferences/graph-view";
import { isFileView, type FileView } from "../preferences/file-view";

import { CHANGE_AREAS, type ChangeArea } from "../repository/repository-read";
import { isOneOf, isRecord } from "../validation";

export type PanelId = "graph" | "diff" | "rail";

export type SavedSelection =
  | { kind: "commit"; oid: string }
  | {
      kind: "change";
      path: string;
      area: ChangeArea;
    }
  | null;

export interface RepositoryView {
  graphFilter?: GraphFilter;
  files?: FileView;
  graphColumns?: SavedGraphColumn[];
  references?: { hidden: boolean; locals: boolean; remotes: boolean; tags: boolean };
  selection: SavedSelection;
  maximized: PanelId | null;
  collapsed: Record<PanelId, boolean>;
  splits: Record<string, number>;
  grouped: boolean;
}

export interface ProfileSession {
  version: 1;
  tabs: string[];
  selectedRepositoryId: string | null;
  views: Record<string, RepositoryView>;
}

export interface CommitDraft {
  version: 1;
  message: string;
  amend: boolean;
  signOff?: boolean;
}

export interface SessionContext {
  profileId: string;
  windowId: string;
  generation: number;
}

export interface SessionSnapshot {
  context: SessionContext;
  session: ProfileSession;
  drafts: Record<string, CommitDraft>;
  recovery: string | null;
}

export type SessionChange =
  | { kind: "tabs"; tabs: string[]; selectedRepositoryId: string | null }
  | { kind: "view"; repositoryId: string; view: RepositoryView }
  | { kind: "draft"; repositoryId: string; draft: CommitDraft };

export interface DuplicateProfileOptions {
  name: string;
  preferences: boolean;
  repositories: boolean;
  tabs: boolean;
}

export interface ProfileDeletePreview {
  profileId: string;
  name: string;
  repositories: number;
  drafts: number;
  fallback: { id: string; name: string } | null;
  active: boolean;
  token: string;
}

export interface GitConfigEntry {
  key: string;
  value?: string;
  origin?: string;
  scope?: string;
}

export const COMMIT_CONFIG_KEYS = {
  author: ["user.name", "user.email"],
  signing: ["gpg.format", "user.signingkey", "commit.gpgsign"],
} as const;

export type CommitConfigGroup = keyof typeof COMMIT_CONFIG_KEYS | "all";

export function commitConfigKeys(group: CommitConfigGroup): readonly string[] {
  return group === "all"
    ? [...COMMIT_CONFIG_KEYS.author, ...COMMIT_CONFIG_KEYS.signing]
    : COMMIT_CONFIG_KEYS[group];
}

export interface ProfileGitInspection {
  profileId: string;
  global: GitConfigEntry[];
  repository: GitConfigEntry[] | null;
  localOverrides: string[] | null;
}

export const emptySession = (): ProfileSession => ({
  version: 1,
  tabs: [],
  selectedRepositoryId: null,
  views: {},
});

export const emptyDraft = (): CommitDraft => ({ version: 1, message: "", amend: false });
export const emptyView = (): RepositoryView => ({
  selection: null,
  maximized: null,
  collapsed: { graph: false, diff: false, rail: false },
  splits: {},
  grouped: false,
});

const only = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const panel = (value: unknown): value is PanelId =>
  value === "graph" || value === "diff" || value === "rail";
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  !["__proto__", "prototype", "constructor"].includes(value);

export function isSelection(value: unknown): value is SavedSelection {
  if (value === null) return true;
  if (!isRecord(value)) return false;

  if (value["kind"] === "commit")
    return (
      only(value, ["kind", "oid"]) &&
      typeof value["oid"] === "string" &&
      /^[a-f0-9]{4,64}$/i.test(value["oid"])
    );

  return (
    only(value, ["kind", "path", "area"]) &&
    value["kind"] === "change" &&
    typeof value["path"] === "string" &&
    value["path"].length <= 4096 &&
    isOneOf(value["area"], CHANGE_AREAS)
  );
}

export function isView(value: unknown): value is RepositoryView {
  if (
    !isRecord(value) ||
    !only(value, [
      "selection",
      "maximized",
      "collapsed",
      "splits",
      "grouped",
      "references",
      "graphColumns",
      "graphFilter",
      "files",
    ]) ||
    (value["graphColumns"] !== undefined && !isGraphColumns(value["graphColumns"])) ||
    (value["graphFilter"] !== undefined && !isGraphFilter(value["graphFilter"])) ||
    (value["files"] !== undefined && !isFileView(value["files"])) ||
    !isSelection(value["selection"]) ||
    !(value["maximized"] === null || panel(value["maximized"])) ||
    typeof value["grouped"] !== "boolean"
  )
    return false;

  const references = value["references"];

  if (
    references !== undefined &&
    (!isRecord(references) ||
      !only(references, ["hidden", "locals", "remotes", "tags"]) ||
      !["hidden", "locals", "remotes", "tags"].every((key) => typeof references[key] === "boolean"))
  )
    return false;

  const collapsed = value["collapsed"];

  if (
    !isRecord(collapsed) ||
    !only(collapsed, ["graph", "diff", "rail"]) ||
    !["graph", "diff", "rail"].every((key) => typeof collapsed[key] === "boolean") ||
    ["graph", "diff", "rail"].every((key) => collapsed[key] === true)
  )
    return false;

  const splits = value["splits"];

  return (
    isRecord(splits) &&
    Object.keys(splits).length <= 20 &&
    Object.entries(splits).every(
      ([key, fraction]) =>
        id(key) &&
        typeof fraction === "number" &&
        Number.isFinite(fraction) &&
        fraction > 0 &&
        fraction < 1,
    )
  );
}

export function isDraft(value: unknown): value is CommitDraft {
  return (
    isRecord(value) &&
    only(value, ["version", "message", "amend", "signOff"]) &&
    (value["signOff"] === undefined || typeof value["signOff"] === "boolean") &&
    value["version"] === 1 &&
    typeof value["message"] === "string" &&
    value["message"].length <= 100_000 &&
    typeof value["amend"] === "boolean"
  );
}

export function isSession(value: unknown): value is ProfileSession {
  if (
    !isRecord(value) ||
    !only(value, ["version", "tabs", "selectedRepositoryId", "views"]) ||
    value["version"] !== 1 ||
    !Array.isArray(value["tabs"]) ||
    value["tabs"].length > 500 ||
    !value["tabs"].every(id)
  )
    return false;

  const selected = value["selectedRepositoryId"];

  if (
    new Set(value["tabs"]).size !== value["tabs"].length ||
    !(selected === null || (typeof selected === "string" && value["tabs"].includes(selected)))
  )
    return false;

  const views = value["views"];

  return (
    isRecord(views) &&
    Object.keys(views).length <= 2000 &&
    Object.entries(views).every(([key, view]) => id(key) && isView(view))
  );
}

export function isSessionChange(value: unknown): value is SessionChange {
  if (!isRecord(value)) return false;

  if (value["kind"] === "tabs")
    return isSession({
      ...emptySession(),
      tabs: value["tabs"],
      selectedRepositoryId: value["selectedRepositoryId"],
    });

  if (!id(value["repositoryId"])) return false;

  return value["kind"] === "draft"
    ? isDraft(value["draft"])
    : value["kind"] === "view" && isView(value["view"]);
}
