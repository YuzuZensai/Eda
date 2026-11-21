import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function saveFile(destination: string, bytes: Buffer) {
  const folder = await mkdtemp(join(dirname(destination), ".eda-save-"));
  try {
    const temporary = join(folder, "contents");
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
