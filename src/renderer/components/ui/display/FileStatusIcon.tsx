import type { ChangeCode, FileDiff } from "@shared/repository/repository-read";
import { MinusIcon as Minus, PencilIcon as Pencil, PlusIcon as Plus } from "../icons";

export function fileStatusTone(status: ChangeCode | FileDiff["status"]) {
  switch (status) {
    case "A":
    case "?":
    case "C":
    case "added":
    case "copied":
      return "text-git-added";
    case "D":
    case "deleted":
      return "text-git-deleted";
    case "M":
    case "T":
    case "modified":
    case "type-changed":
      return "text-git-modified";
    case "R":
    case "renamed":
      return "text-git-renamed";
    case "U":
      return "text-git-conflict";
    default:
      return "text-text-tertiary";
  }
}

export function FileStatusIcon({ status }: { status: ChangeCode | FileDiff["status"] }) {
  switch (status) {
    case "A":
    case "?":
    case "added":
      return <Plus size={13} aria-hidden="true" />;
    case "D":
    case "deleted":
      return <Minus size={13} aria-hidden="true" />;
    case "M":
    case "modified":
      return <Pencil size={13} aria-hidden="true" />;
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "type-changed":
      return "T";
    default:
      return status;
  }
}
