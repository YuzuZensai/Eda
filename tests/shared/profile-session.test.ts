import { expect, it } from "vitest";
import { emptyView, isView } from "@shared/identity/profile-session";

it("accepts saved Refs widths within the column limits", () => {
  for (const width of [48, 150, 320])
    expect(isView({ ...emptyView(), refsColumnWidth: width })).toBe(true);
  for (const width of [47, 321, 95.5, "96"])
    expect(isView({ ...emptyView(), refsColumnWidth: width })).toBe(false);
});

it("accepts old saved views and validates optional reference navigation state", () => {
  expect(isView(emptyView())).toBe(true);
  expect(
    isView({
      ...emptyView(),
      references: { hidden: true, locals: true, remotes: false, tags: true },
    }),
  ).toBe(true);
  expect(isView({ ...emptyView(), references: { hidden: false } })).toBe(false);
  expect(
    isView({
      ...emptyView(),
      references: { hidden: "false", locals: true, remotes: true, tags: true },
    }),
  ).toBe(false);
});
