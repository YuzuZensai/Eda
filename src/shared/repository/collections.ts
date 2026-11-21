import { isRecord } from "../validation";

export interface CollectionMember {
  name: string;
  repositoryId?: string;
  remote?: string;
  pathHint?: string;
}
export interface LocalCollection {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  members: CollectionMember[];
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !/[\x00-\x1f]/.test(value);
export function portableRemote(value: unknown): value is string {
  if (!text(value, 4096) || !value || /[\s\\?#]/.test(value)) return false;
  if (/^[\w.-]+@[\w.-]+:[^:]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      ((url.protocol === "https:" && !url.username) || url.protocol === "ssh:") &&
      !!url.hostname &&
      !url.password
    );
  } catch {
    return false;
  }
}
function isMember(value: unknown): value is CollectionMember {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).every((key) =>
      ["name", "repositoryId", "remote", "pathHint"].includes(key),
    ) &&
    text(value["name"], 200) &&
    !!value["name"].trim() &&
    (value["repositoryId"] === undefined || text(value["repositoryId"], 64)) &&
    (value["remote"] === undefined || portableRemote(value["remote"])) &&
    (value["pathHint"] === undefined || text(value["pathHint"], 4096))
  );
}
export function isCollection(value: unknown): value is LocalCollection {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).every((key) =>
      ["id", "name", "icon", "color", "description", "members"].includes(key),
    ) &&
    text(value["id"], 64) &&
    !!value["id"] &&
    text(value["name"], 100) &&
    !!value["name"].trim() &&
    text(value["description"], 500) &&
    text(value["icon"], 8) &&
    typeof value["color"] === "string" &&
    /^#[a-f0-9]{6}$/i.test(value["color"]) &&
    Array.isArray(value["members"]) &&
    value["members"].length <= 100 &&
    value["members"].every(isMember)
  );
}
export function isCollectionList(value: unknown): value is LocalCollection[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(isCollection) &&
    JSON.stringify(value).length <= 1024 * 1024 &&
    new Set(value.map((item) => item.id)).size === value.length
  );
}
export function collectionManifest(collection: LocalCollection, paths: boolean) {
  return {
    version: 1,
    name: collection.name,
    description: collection.description,
    icon: collection.icon,
    color: collection.color,
    members: collection.members.map((member) => ({
      name: member.name,
      ...(member.remote && { remote: member.remote }),
      ...(paths && member.pathHint && { pathHint: member.pathHint }),
    })),
  };
}
export function importCollection(value: unknown, id: string): LocalCollection | null {
  if (!isRecord(value) || value["version"] !== 1) return null;
  const { version: _, ...fields } = value;
  const collection = { ...fields, id };
  return isCollection(collection) && collection.members.every((member) => !member.repositoryId)
    ? collection
    : null;
}
