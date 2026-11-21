import { isFullObjectId } from "../src/shared/repository/object-id.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import ts from "typescript";
import { format, resolveConfig } from "prettier";
import { basename, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import type { BuildInfo } from "../src/shared/version.ts";

// Store each namespace once in production, preserving the flat keys used by i18next and IPC.
export function compactMessageCatalogs(): Plugin {
  const suffix = ".eda-messages.js";
  return {
    name: "eda-message-catalogs",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!source.includes("locales/") || !source.endsWith(".json")) return;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (resolved && /[/\\]shared[/\\]locales[/\\]/.test(resolved.id)) return resolved.id + suffix;
      return null;
    },
    async load(id) {
      if (!id.endsWith(suffix)) return;
      const file = id.slice(0, -suffix.length);
      this.addWatchFile(file);
      const messages: Record<string, unknown> = JSON.parse(await readFile(file, "utf8"));
      const groups = new Map<string, Record<string, unknown>>();
      for (const [key, value] of Object.entries(messages)) {
        const end = key.lastIndexOf(".") + 1;
        const prefix = key.slice(0, end);
        const group = groups.get(prefix) ?? {};
        group[key.slice(end)] = value;
        groups.set(prefix, group);
      }
      return `const messages = {};
        for (const [prefix, group] of ${JSON.stringify([...groups])}) {
          for (const [key, value] of Object.entries(group)) messages[prefix + key] = value;
        }
        export default messages;`;
    },
  };
}

export function readBuildInfo(root = fileURLToPath(new URL("../", import.meta.url))): BuildInfo {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };

  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Eda's package.json version must be a stable semantic version (X.Y.Z).");

  let commit: string | null = null;
  let dirty: boolean | null = null;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();

  try {
    if (realpathSync(git("rev-parse", "--show-toplevel")) === realpathSync(root)) {
      const head = git("rev-parse", "--verify", "HEAD");
      if (!isFullObjectId(head)) throw new Error("Invalid Git commit.");

      commit = head;
      dirty =
        git("status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none") !==
        "";
    }
  } catch {}

  const revision = commit ? commit.slice(0, 12) : "unknown";
  const suffix = dirty === true ? "-dirty" : dirty === null && commit ? "-unknown" : "";

  return { version, displayVersion: `${version}-${revision}${suffix}`, commit, dirty };
}

export function electronStderr(allDiagnostics = false): Transform {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let reported = false;
  const timing =
    /^\[\d+:\d+(?::\d+)?\/[^\]\r\n]+:ERROR:components\/viz\/service\/display\/display\.cc:\d+\]\s*:?[ \t]*Frame latency is negative: -\d+(?:\.\d+)? ms\r?\n?$/;
  const forward = (stream: Transform, line: string) => {
    if (!allDiagnostics && timing.test(line)) {
      if (reported) return;
      reported = true;
      stream.push(line);
      stream.push(
        "[Eda graphics] Repeated Chromium frame-timing messages omitted; EDA_CHROMIUM_DIAGNOSTICS=1 shows all.\n",
      );
    } else stream.push(line);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        forward(this, pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > 64 * 1024) {
        this.push(pending);
        pending = "";
      }
      done();
    },
    flush(done) {
      forward(this, pending + decoder.end());
      done();
    },
  });
}

export async function prepareComponentInventory(check = false): Promise<void> {
  const root = fileURLToPath(new URL("../src/renderer/", import.meta.url));

  async function collect(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? collect(join(directory, entry.name))
          : entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")
            ? [join(directory, entry.name)]
            : [],
      ),
    );

    return paths.flat();
  }

  const paths = (await collect(root)).filter((path) => relative(root, path) !== "main.tsx").sort();
  const groups = new Map<string, string[]>();
  const exports: Record<string, string[]> = {};
  const ui: string[] = [];

  for (const path of paths) {
    const file = relative(root, path).replaceAll("\\", "/");
    const source = ts.createSourceFile(
      file,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const names: string[] = [];

    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause))
          names.push(
            ...statement.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => element.name.text),
          );

        continue;
      }

      if (
        !ts.canHaveModifiers(statement) ||
        !ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue;

      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name
      )
        names.push(statement.name.text);

      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    }

    exports[file] = names.filter((name) => /^[A-Z][a-zA-Z0-9]*$/.test(name));

    if (file.startsWith("components/ui/")) {
      ui.push(file);
      continue;
    }

    const folder = dirname(file).replace(/^features\//, "");
    const group =
      folder === "tutorial"
        ? "Tutorial"
        : folder === "app"
          ? "Application"
          : folder === "components/layout"
            ? "Layout"
            : folder === "devtools/component-gallery"
              ? "Component gallery"
              : folder[0]!.toUpperCase() + folder.slice(1);

    groups.set(group, [...(groups.get(group) ?? []), file]);
  }

  const owners = new Map<string, string>();
  for (const [file, names] of Object.entries(exports)) {
    for (const name of names) {
      const previous = owners.get(name);
      if (previous) throw new Error(`Duplicate component export ${name}: ${previous}, ${file}`);
      owners.set(name, file);
    }
  }

  const target = join(root, "devtools/component-gallery/componentInventory.ts");
  const inventory = [
    { group: null, files: ui },
    ...[...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, files]) => ({ group, files })),
  ].map(({ group, files }) => {
    const directory =
      group === null ? "components/ui/" : files[0]!.slice(0, files[0]!.lastIndexOf("/") + 1);
    return {
      group,
      directory,
      files: files.map((file) => {
        const name = file.slice(directory.length, -4);
        const names = exports[file]!;
        return names.length === 1 && names[0] === basename(name) ? name : [name, names];
      }),
    };
  });

  const output = await format(
    `// Generated by scripts/build.ts when Vite starts. Don't edit this file directly.\nexport const COMPONENT_GROUPS: {group: string | null; directory: string; files: (string | [file: string, exports: string[]])[]}[] = ${JSON.stringify(inventory)};\n`,
    { ...(await resolveConfig(target)), parser: "typescript" },
  );

  if ((await readFile(target, "utf8").catch(() => "")) !== output) {
    if (check) throw new Error(`Stale component inventory: ${target}. Run pnpm build.`);
    await writeFile(target, output);
  }

  console.log(
    `Component inventory: ${paths.length} source files, ${Object.values(exports).flat().length} exported components.`,
  );
}
