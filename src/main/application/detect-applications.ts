import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { DetectedMergeTool } from "@shared/integrations/merge-tool";
import type { DetectedEditor } from "@shared/application";

interface ApplicationCandidate {
  name: string;
  command: string;
  mac?: string;
  windows?: string;
}

async function detectApplications(
  candidates: readonly ApplicationCandidate[],
): Promise<DetectedEditor[]> {
  const home = homedir();
  const searchPath = (process.env["PATH"] ?? "").split(delimiter).filter(isAbsolute);
  const windowsRoots = [
    process.env["LOCALAPPDATA"] && join(process.env["LOCALAPPDATA"], "Programs"),
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
  ].filter((root): root is string => !!root && isAbsolute(root));
  const detected = await Promise.all(
    candidates.map(async (editor): Promise<DetectedEditor | null> => {
      const candidates = searchPath.map((directory) =>
        join(directory, editor.command + (process.platform === "win32" ? ".exe" : "")),
      );

      if (process.platform === "darwin" && editor.mac)
        candidates.push(join("/Applications", editor.mac), join(home, "Applications", editor.mac));
      if (process.platform === "win32" && editor.windows)
        candidates.push(...windowsRoots.map((root) => join(root, editor.windows!)));

      if (process.platform === "linux")
        candidates.push(
          ...["/usr/bin", "/usr/local/bin", "/snap/bin", join(home, ".local/bin")].map((root) =>
            join(root, editor.command),
          ),
        );

      for (const executable of new Set(candidates)) {
        try {
          await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
          if ((await stat(executable)).isFile()) return { name: editor.name, executable };
        } catch {}
      }

      return null;
    }),
  );

  return detected.filter((editor): editor is DetectedEditor => editor !== null);
}

const EDITOR_CANDIDATES = [
  {
    name: "Visual Studio Code",
    command: "code",
    mac: "Visual Studio Code.app/Contents/Resources/app/bin/code",
    windows: "Microsoft VS Code/Code.exe",
  },
  {
    name: "Visual Studio Code Insiders",
    command: "code-insiders",
    mac: "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
    windows: "Microsoft VS Code Insiders/Code - Insiders.exe",
  },
  {
    name: "VSCodium",
    command: "codium",
    mac: "VSCodium.app/Contents/Resources/app/bin/codium",
    windows: "VSCodium/VSCodium.exe",
  },
  {
    name: "Cursor",
    command: "cursor",
    mac: "Cursor.app/Contents/Resources/app/bin/cursor",
    windows: "cursor/Cursor.exe",
  },
  {
    name: "Windsurf",
    command: "windsurf",
    mac: "Windsurf.app/Contents/Resources/app/bin/windsurf",
    windows: "Windsurf/Windsurf.exe",
  },
  { name: "Zed", command: "zed", mac: "Zed.app/Contents/MacOS/cli", windows: "Zed/zed.exe" },
  {
    name: "Sublime Text",
    command: "subl",
    mac: "Sublime Text.app/Contents/SharedSupport/bin/subl",
    windows: "Sublime Text/subl.exe",
  },
  { name: "Notepad++", command: "notepad++", windows: "Notepad++/notepad++.exe" },
  { name: "Kate", command: "kate" },
  { name: "GNOME Text Editor", command: "gnome-text-editor" },
  { name: "Gedit", command: "gedit" },
] as const;

export function detectEditors(): Promise<DetectedEditor[]> {
  return detectApplications(EDITOR_CANDIDATES);
}

export async function detectMergeTools(): Promise<DetectedMergeTool[]> {
  const tools = await detectApplications([
    ...EDITOR_CANDIDATES.filter((editor) => ["code", "code-insiders"].includes(editor.command)),
    {
      name: "Meld",
      command: "meld",
      mac: "Meld.app/Contents/MacOS/Meld",
      windows: "Meld/Meld.exe",
    },
    {
      name: "KDiff3",
      command: "kdiff3",
      mac: "kdiff3.app/Contents/MacOS/kdiff3",
      windows: "KDiff3/kdiff3.exe",
    },
  ]);

  return tools.map((tool) => ({
    ...tool,
    args:
      tool.name === "Meld"
        ? ["--output={result}", "{current}", "{base}", "{incoming}"]
        : tool.name === "KDiff3"
          ? ["{base}", "{current}", "{incoming}", "--output", "{result}"]
          : ["--wait", "--merge", "{incoming}", "{current}", "{base}", "{result}"],
  }));
}
