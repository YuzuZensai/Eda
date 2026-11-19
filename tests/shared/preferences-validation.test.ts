import { expect, it } from "vitest";
import { emptyView, isView } from "@shared/identity/profile-session";
import { defaultFileView, isFileView } from "@shared/preferences/file-view";
import { builtInSetting, validateSetting } from "@shared/preferences/settings";
import { defaultGraphFilter, isGraphFilter } from "@shared/preferences/graph-view";

it("accepts absolute repository roots and rejects relative paths, control characters, and non-path values", () => {
  for (const path of [
    "",
    "/repos",
    "/repos with spaces",
    "C:\\Users\\dev\\repos",
    "\\\\server\\repos",
  ])
    expect(() =>
      validateSetting("repositoryRoot", { kind: "profile", profileId: "work" }, path),
    ).not.toThrow();
  for (const path of [
    "repos",
    "~/repos",
    "/repos\nother",
    "/repos\0",
    "x".repeat(4097),
    null,
    [],
    1,
  ])
    expect(() =>
      validateSetting("repositoryRoot", { kind: "profile", profileId: "work" }, path),
    ).toThrow();
});

it("keeps existing graph views valid and accepts only explicit boolean overrides for internal refs", () => {
  const legacy = defaultGraphFilter();
  expect(isGraphFilter(legacy)).toBe(true);
  for (const showInternalRefs of [undefined, false, true])
    expect(isView({ ...emptyView(), graphFilter: { ...legacy, showInternalRefs } })).toBe(true);
  for (const showInternalRefs of [null, "true", 1, [true]])
    expect(isGraphFilter({ ...legacy, showInternalRefs })).toBe(false);
});

it("rejects saved selection areas that only coerce to valid strings", () => {
  for (const area of [["staged"], { toString: () => "staged" }]) {
    expect(isView({ ...emptyView(), selection: { kind: "change", path: "file", area } })).toBe(
      false,
    );
  }
});

it("rejects coerced file display modes and status filters", () => {
  const files = defaultFileView();
  expect(isFileView(files)).toBe(true);
  for (const mode of [["tree"], { toString: () => "tree" }])
    expect(isFileView({ ...files, mode })).toBe(false);
  for (const status of [[], ["M"], { toString: () => "M" }])
    expect(isFileView({ ...files, status })).toBe(false);
});

it("rejects theme modes that only coerce to a supported value", () => {
  const theme = builtInSetting("theme").value;
  for (const mode of [["system"], { toString: () => "system" }])
    expect(() => validateSetting("theme", { kind: "application" }, { ...theme, mode })).toThrow();
});

it("returns independent preference defaults for each caller", () => {
  const theme = builtInSetting("theme");
  theme.value.mode = "dark";
  expect(builtInSetting("theme").value.mode).toBe("system");
  const prefixes = builtInSetting("commitPrefixes").value;
  const expected = [...prefixes];
  prefixes.push("custom");
  expect(builtInSetting("commitPrefixes").value).toEqual(expected);
});

it("accepts only unique known history column IDs in the global visibility setting", () => {
  for (const columns of [[], ["sha"], ["author", "date", "sha"]])
    expect(() =>
      validateSetting("historyVisibleColumns", { kind: "application" }, columns),
    ).not.toThrow();
  for (const columns of [null, true, "sha", ["unknown"], ["sha", "sha"], [1], [["author"]]])
    expect(() =>
      validateSetting("historyVisibleColumns", { kind: "application" }, columns),
    ).toThrow();
});
