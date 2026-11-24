import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

test("application sources contain no test suites or test-support directories", async () => {
  const files = await readdir("src", { recursive: true });
  const misplaced = files.filter(
    (file) =>
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
      /(^|[\\/])(__tests__|tests?)([\\/]|$)/.test(file),
  );
  assert.deepEqual(misplaced, [], "Keep suites, fixtures and test-only helpers under tests/.");
});

const cases = [
  ["renderer/features/connections/GitHubConnection.tsx", "lucide-react", false],
  ["renderer/components/ui/actions/Button.tsx", "lucide-react", false],
  ["renderer/components/ui/icons.tsx", "lucide-react", true],
  ["renderer/components/ui/icons.tsx", "node:fs", false],
  ["renderer/components/ui/icons.tsx", "@renderer/features/changes/ChangesPanel", false],
  ["main/git/security/repository-trust.ts", "drizzle-orm", false],
  ["main/identity/profile-service.ts", "drizzle-orm", false],
  ["main/identity/profile-service.ts", "drizzle-orm/node-sqlite", false],
  ["main/persistence/repository-memberships.ts", "drizzle-orm", true],
  ["main/services.ts", "node:child_process", false],
  ["main/services.ts", "child_process", false],
  ["main/services.ts", "node:sqlite", false],
  ["main/git/execution/process-runner.ts", "node:child_process", true],
  ["main/git/execution/process-runner.ts", "node:sqlite", false],
  ["main/persistence/database.ts", "node:sqlite", true],
  ["main/persistence/database.ts", "node:child_process", false],
  ["main/services.ts", "@renderer/stores/app-store", false],
  ["renderer/app/App.tsx", "electron", false],
  ["renderer/app/App.tsx", "node:fs", false],
  ["renderer/app/App.tsx", "fs/promises", false],
  ["renderer/app/App.tsx", "crypto", false],
  ["renderer/app/App.tsx", "@main/services", false],
  ["renderer/app/App.tsx", "../../main/services", false],
  ["renderer/app/App.tsx", "@shared/ipc", true],
  ["renderer/components/ui/actions/Button.tsx", "@renderer/features/changes/ChangesPanel", false],
  ["renderer/components/ui/actions/Button.tsx", "../../../features/changes/ChangesPanel", false],
  ["renderer/components/ui/actions/Button.tsx", "@renderer/app/App", false],
  [
    "renderer/components/layout/Split.tsx",
    "@renderer/devtools/component-gallery/ComponentGallery",
    false,
  ],
  ["renderer/components/layout/Split.tsx", "../ui/actions/Button", true],
  ["renderer/features/history/CommitGraph.tsx", "@renderer/app/Workspace", false],
  ["renderer/features/history/CommitGraph.tsx", "../../app/Workspace", false],
  ["renderer/features/history/CommitGraph.tsx", "@renderer/components/ui/actions/Button", true],
  ["renderer/features/history/CommitGraph.tsx", "electron", false],
  ["shared/ipc.ts", "electron", false],
  ["shared/ipc.ts", "react", false],
  ["shared/ipc.ts", "react/jsx-runtime", false],
  ["shared/ipc.ts", "node:path", false],
  ["shared/ipc.ts", "@main/services", false],
  ["shared/ipc.ts", "../renderer/stores/app-store", false],
  ["shared/ipc.ts", "./errors", true],
  ["main/services.ts", "../../tests/helpers/temp-repo", false],
  ["renderer/app/App.tsx", "../../tests/fixtures/repository-read-output", false],
  ["shared/ipc.ts", "../../tests/shared/errors.test", false],
] as const;

for (const [file, dependency, allowed] of cases) {
  test(`${file} ${allowed ? "allows" : "rejects"} ${dependency}`, async () => {
    const [result] = await eslint.lintText(`import '${dependency}';`, { filePath: `src/${file}` });
    assert.ok(result);
    const violations = result.messages.filter(
      (message) => message.ruleId === "no-restricted-imports",
    );
    assert.equal(violations.length, allowed ? 0 : 1, JSON.stringify(result.messages));
  });
}

for (const [file, allowed] of [
  ["main/secrets/keychain-secret-store.ts", true],
  ["main/credentials/credential-service.ts", false],
] as const) {
  test(`${file} ${allowed ? "allows" : "rejects"} direct vault access`, async () => {
    const [result] = await eslint.lintText('safeStorage.encryptString("secret");', {
      filePath: `src/${file}`,
    });

    assert.ok(result);

    const violations = result.messages.filter(
      (message) => message.ruleId === "no-restricted-syntax",
    );

    assert.equal(violations.length, allowed ? 0 : 1);
  });
}

for (const file of [
  "renderer/app/App.tsx",
  "renderer/tutorial/TourGuide.tsx",
  "renderer/features/settings/Settings.tsx",
  "renderer/features/history/CommitRow.tsx",
]) {
  test(`${file} requires shared form controls`, async () => {
    const tags = ["button", "input", "select", "textarea"];
    const source = tags.map((tag) => `<${tag} />`).join("\n");
    const [result] = await eslint.lintText(`const Control = () => <>\n${source}\n</>;`, {
      filePath: `src/${file}`,
    });
    assert.deepEqual(
      result?.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.line),
      [2, 3, 4, 5],
    );
  });
}

test("renderer animation definitions stay in the shared motion stylesheet", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = await readdir("src/renderer", { recursive: true });
  for (const file of files.filter((file) => /\.(css|tsx?)$/.test(file))) {
    if (file === "styles/motion.css") continue;
    const source = await readFile(`src/renderer/${file}`, "utf8");
    assert.doesNotMatch(
      source,
      /@keyframes\s/,
      `Move animation definitions in ${file} to styles/motion.css`,
    );
  }
});

for (const file of [
  "renderer/app/CommandPalette.tsx",
  "renderer/commands/hooks/useShellCommands.ts",
]) {
  test(`${file} rejects imperative discovery and global events`, async () => {
    const source = [
      "document.querySelector('[role=dialog]');",
      "root.current?.querySelectorAll('button');",
      "document.getElementById('owned-control');",
      "window.dispatchEvent(new CustomEvent('eda:settings'));",
    ].join("\n");
    const [result] = await eslint.lintText(source, { filePath: `src/${file}` });
    assert.deepEqual(
      result?.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.line),
      [1, 2, 3, 4],
    );
  });
}

test("shared menu primitives may discover composed focus targets", async () => {
  const [result] = await eslint.lintText("root.current?.querySelectorAll('[role=menuitem]');", {
    filePath: "src/renderer/components/ui/hooks/useMenuKeyboard.ts",
  });
  assert.ok(result);
  assert.ok(!result.messages.some((message) => message.ruleId === "no-restricted-syntax"));
});
