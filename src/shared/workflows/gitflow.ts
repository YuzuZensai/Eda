import { isRecord, isOneOf } from "../validation";
import { isFullObjectId } from "../repository/object-id";

export const flowKinds = ["feature", "release", "hotfix"] as const;
export type FlowKind = (typeof flowKinds)[number];
export interface FlowConfig {
  production: string;
  development: string;
  feature: string;
  release: string;
  hotfix: string;
}
export interface FlowPlan {
  kind: FlowKind;
  name: string;
  branch: string;
  oid: string;
  targets: { name: string; before: string }[];
  tag: string | null;
  retain: boolean;
}
export interface FlowState {
  config: FlowConfig | null;
  pending: FlowPlan | null;
}
export type FlowAction =
  | { kind: "configure"; config: FlowConfig }
  | { kind: "start" | "preview"; type: FlowKind; name: string; retain: boolean }
  | { kind: "finish"; plan: FlowPlan }
  | { kind: "resume" | "retain" };
const name = (v: unknown): v is string => typeof v === "string" && !!v && v.length <= 255;
export function isFlowConfig(v: unknown): v is FlowConfig {
  return isRecord(v) && ["production", "development", ...flowKinds].every((k) => name(v[k]));
}
export function isFlowPlan(v: unknown): v is FlowPlan {
  return (
    isRecord(v) &&
    isOneOf(v["kind"], flowKinds) &&
    name(v["name"]) &&
    name(v["branch"]) &&
    isFullObjectId(v["oid"]) &&
    (v["tag"] === null || name(v["tag"])) &&
    typeof v["retain"] === "boolean" &&
    Array.isArray(v["targets"]) &&
    v["targets"].length >= 1 &&
    v["targets"].length <= 2 &&
    v["targets"].every(
      (item) => isRecord(item) && name(item["name"]) && isFullObjectId(item["before"]),
    )
  );
}
