import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLocalization } from "../../scripts/check-localization.ts";

test("the localization command logs catalog errors as it finds them and exits with status 1", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, mkdir, open, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "eda-localization-usage-"));
  try {
    await mkdir(join(root, "src/shared/locales/en"), { recursive: true });
    await mkdir(join(root, "src/shared/locales/fr"), { recursive: true });
    await mkdir(join(root, "src/shared/i18n"));
    await mkdir(join(root, "tests"));
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          resolveJsonModule: true,
          strict: true,
        },
      }),
    );
    await writeFile(
      join(root, "src/shared/locales/en/common.json"),
      JSON.stringify({
        "example.rich": "View <code/>",
        "example.alpha": "Alpha",
        "example.commentOnly": "Comment",
        "example.count": { other: "{count} items", one: "{count} item" },
        "example.mapped": "Mapped",
        "example.modeLong": "Long",
        "example.modeShort": "Short",
        "example.modeUnused": "Unused mode",
        "example.testOnly": "Test",
        "example.unrelated": "Unrelated",
      }),
    );
    await writeFile(
      join(root, "src/shared/locales/fr/common.json"),
      JSON.stringify({ "example.modeUnused": "Mode inutilisé", "example.alpha": "Alpha" }),
    );
    await writeFile(join(root, "src/shared/locales/fr/invalid.json"), "{");
    await writeFile(
      join(root, "src/shared/i18n/index.ts"),
      `
      import english from "../locales/en/common.json";
      export type MessageKey = keyof typeof english;
      export declare function t(key: MessageKey, values?: { count: number }): string;
      export declare function Localized(props: { id: MessageKey }): null;
      `,
    );
    await writeFile(
      join(root, "src/Example.tsx"),
      `
      import { t as translate, Localized, type MessageKey } from "./shared/i18n";
      declare const mode: "Long" | "Short";
      const messages: Record<string, MessageKey> = { label: "example.mapped" };
      const rich = "example.rich" as const;
      export const label = translate("example.alpha");
      export const modeLabel = translate(\`example.mode\${mode}\`);
      export const mappedLabel = translate(messages["label"]);
      export const count = translate("example.count", { count: 1 });
      export const Rich = () => <Localized id={rich} />;
      export const forward = (key: MessageKey) => translate(key);
      export const unrelated = "example.unrelated";
      // translate("example.commentOnly");
      `,
    );
    await writeFile(join(root, "tests/fixture.ts"), 'translate("example.testOnly");');

    const command = fileURLToPath(new URL("../../scripts/check-localization.ts", import.meta.url));
    const logPath = join(root, "localization.log");
    const log = await open(logPath, "w");
    const result = spawnSync(process.execPath, [command], {
      cwd: root,
      stdio: ["ignore", log.fd, log.fd],
    });
    await log.close();

    const output = await readFile(logPath, "utf8");
    assert.ifError(result.error);
    assert.equal(result.status, 1, output);
    assert.match(output, /en\/common\.json \(10 keys\)\n[^\n]+alphabetical order requires/);
    assert.match(output, /fr\/invalid\.json \(invalid catalog\)\n[^\n]+invalid JSON/);
    assert.match(output, /Checking application references in 2 TypeScript files\./);
    assert.match(
      output,
      /Locales: 2 \| Catalogs: 3 \| Keys: 12\nLocalization checks failed \(9 errors\)\./,
    );

    const catalogErrors = output
      .split("\n")
      .filter((line) => line.startsWith("src/shared/locales/") && !line.includes("/invalid.json"));
    assert.deepEqual(
      catalogErrors.sort(),
      [
        "en/common.json: alphabetical order requires example.alpha before example.rich",
        "en/common.json: example.commentOnly: unused key",
        "en/common.json: example.count: alphabetical order requires one before other",
        "en/common.json: example.modeUnused: unused key",
        "en/common.json: example.testOnly: unused key",
        "en/common.json: example.unrelated: unused key",
        "fr/common.json: alphabetical order requires example.alpha before example.modeUnused",
        "fr/common.json: example.modeUnused: unused key",
      ].map((error) => `src/shared/locales/${error}`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production catalog compression preserves keys, Unicode and plural forms", async (context) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { build } = await import("vite");
  const { compactMessageCatalogs } = await import("../../scripts/build.ts");
  const root = await mkdtemp(join(tmpdir(), "eda-localization-build-"));
  const repeated = "No repositories match this filter.";
  const catalog = {
    ...Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `sample.message${index}`,
        `日本語 🌸 ${index}: ${repeated}`,
      ]),
    ),
    "sidebar.empty": repeated,
    "workspace.empty": repeated,
    "workspace.count": { one: "{count} repository", other: "{count} repositories" },
  };

  try {
    const locales = "src/shared/locales/en";
    await mkdir(join(root, locales), { recursive: true });
    await writeFile(join(root, locales, "messages.json"), JSON.stringify(catalog));
    const entry = join(root, "entry.js");
    await writeFile(entry, `export { default } from "./${locales}/messages.json";`);

    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [compactMessageCatalogs()],
      build: { lib: { entry, formats: ["es"] }, write: false, minify: false },
    });
    const bundle = Array.isArray(result) ? result[0] : result;
    assert.ok(bundle && "output" in bundle);
    const chunk = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
    assert.ok(chunk?.type === "chunk");
    const module: { default: unknown } = await import(
      "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
    );

    assert.deepEqual(module.default, catalog);
    assert.ok(
      chunk.code.length < JSON.stringify(catalog).length,
      "Catalog packing reduces bundle size",
    );
    await context.test("keeps small catalogs readable without decompression overhead", async () => {
      const small = { "common.close": "Close" };
      await writeFile(join(root, locales, "messages.json"), JSON.stringify(small));
      const smallBuild = await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [compactMessageCatalogs()],
        build: { lib: { entry, formats: ["es"] }, write: false, minify: false },
      });
      const smallBundle = Array.isArray(smallBuild) ? smallBuild[0] : smallBuild;
      assert.ok(smallBundle && "output" in smallBundle);
      const smallChunk = smallBundle.output.find(
        (output) => output.type === "chunk" && output.isEntry,
      );
      assert.ok(smallChunk?.type === "chunk");
      const smallModule = await import(
        "data:text/javascript;base64," + Buffer.from(smallChunk.code).toString("base64")
      );
      assert.deepEqual(smallModule.default, small);
      assert.ok(!smallChunk.code.includes("DecompressionStream"));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports duplicate keys, changed translation parameters, and hard-coded expressions", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "eda-localization-"));
  try {
    await mkdir(join(root, "src/shared/locales/en"), { recursive: true });
    await mkdir(join(root, "src/shared/locales/fr"), { recursive: true });
    await writeFile(
      join(root, "src/shared/locales/en/common.json"),
      '{"example.hello":"Hello {name}","example.hello":"Hello {name}","example.rich":"View <code/>"}',
    );
    await writeFile(
      join(root, "src/shared/locales/fr/common.json"),
      '{"example.hello":"Bonjour {nom}","example.rich":"Voir <wrong/>"}',
    );
    await writeFile(
      join(root, "src/Example.tsx"),
      'const Example = () => <><p>SAVE ALL</p><input placeholder="Search now"/><p>{empty ? "Try again" : "Ready"}</p><p>{t("example.hello")}</p></>;',
    );
    const { issues } = checkLocalization(root);
    assert.ok(issues.some((issue) => issue.includes("duplicate key example.hello")));
    assert.ok(issues.some((issue) => issue.includes("parameters differ from English")));
    assert.ok(
      issues.some(
        (issue) =>
          issue.includes("example.rich") && issue.includes("parameters differ from English"),
      ),
    );
    assert.ok(issues.some((issue) => issue.includes("move visible JSX text")));
    assert.ok(issues.some((issue) => issue.includes("move visible attribute text")));
    assert.ok(issues.some((issue) => issue.includes("move visible expression text")));
    assert.ok(issues.some((issue) => issue.includes("missing parameters: name")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finds indirect display copy and prevents translations from entering protocol or behavior checks", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "eda-localization-sinks-"));
  try {
    await mkdir(join(root, "src/shared/locales/en"), { recursive: true });
    await writeFile(join(root, "src/shared/locales/en/common.json"), '{"example.ready":"Ready"}');
    await writeFile(
      join(root, "src/labels.ts"),
      `
      export function field(value: unknown, field: string): string { return String(value); }
      export function origin(scope: "command"): string { return { command: "Command configuration" }[scope]; }
      export function makeError(message: string): Error { return new Error(message); }
    `,
    );
    await writeFile(
      join(root, "src/Example.tsx"),
      `
      import { field, origin, makeError } from "./labels";
      declare function t(key: string): string;
      const label = "Default label";
      const current = t("example.ready");
      if (current === "Ready") throw makeError("Invalid settings");
      const protocol = { stdin: t("example.ready") };
      const options = { filters: [{ name: "Images", extensions: ["png"] }] };
      field(undefined, "profile name");
      const Example = () => <>
        <PanelControls name="diff viewer" />
        <button title={label}/>
        <p title={origin("command")}/>
        <DefinitionList items={[{ label: t("example.ready"), value: "No selection" }]}/>
        <Localized id="example.ready" values={{ detail: "Fallback detail" }}/>
      </>;
      const technical = { className: "text-red-500", stdin: "delete refs/heads/main", key: "ArrowLeft" };
    `,
    );
    const { issues } = checkLocalization(root);
    for (const reason of [
      "display default label",
      "visible attribute",
      "display property name",
      "display argument field",
      "error message argument",
      "display property value",
      "display property detail",
    ])
      assert.ok(
        issues.some((issue) => issue.includes(reason)),
        `${reason}: ${issues.join("\n")}`,
      );
    assert.ok(issues.some((issue) => issue.includes("src/labels.ts")));
    assert.ok(
      issues.some((issue) => issue.includes("compare stable state")),
      issues.join("\n"),
    );
    assert.ok(
      issues.some((issue) => issue.includes("stdin")),
      issues.join("\n"),
    );
    assert.ok(
      !issues.some((issue) => /text-red-500|delete refs\/heads\/main|ArrowLeft/.test(issue)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
