import { test } from "vitest";
import { parseUnifiedDiff } from "@main/git/parsers/diff-parser";

test("parse a 300,000-line patch with a bounded preview", async ({ bench }) => {
  const patch = Buffer.from(
    "diff --git a/f b/f\n@@ -0,0 +1,300000 @@\n" + "+hello world\n".repeat(300_000),
  );
  await bench("parse", () => {
    parseUnifiedDiff(patch);
  }).run();
});
