import {
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { openDatabase } from "./database";

export async function prepareReleaseDataImport(
  releasePath: string,
  developmentPath: string,
): Promise<void> {
  const fail = () =>
    new GitError({
      kind: "invalid-input",
      operation: t("operations.importReleaseData"),
      message: errorText("main.appData.releaseDataUnavailable"),
    });
  if (!existsSync(releasePath)) throw fail();
  if (realpathSync(releasePath) === realpathSync(developmentPath)) throw fail();

  const sourcePath = join(releasePath, "eda.db");
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) throw fail();

  const stage = mkdtempSync(join(developmentPath, ".release-import-"));

  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      if (
        !source
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
          )
          .get()
      )
        throw fail();
      await backup(source, join(stage, "eda.db"));
    } finally {
      source.close();
    }
    const candidate = openDatabase(join(stage, "eda.db"));
    try {
      if (
        candidate.raw.prepare("PRAGMA quick_check").get()?.["quick_check"] !== "ok" ||
        candidate.raw.prepare("PRAGMA foreign_key_check").all().length
      )
        throw fail();
    } finally {
      candidate.close();
    }

    const vault = join(releasePath, "secrets.vault");
    if (existsSync(vault)) {
      if (!lstatSync(vault).isFile()) throw fail();
      copyFileSync(vault, join(stage, "secrets.vault"), constants.COPYFILE_EXCL);
      if (process.platform !== "win32") chmodSync(join(stage, "secrets.vault"), 0o600);
    }

    rmSync(join(developmentPath, ".release-import-pending"), { recursive: true, force: true });
    renameSync(stage, join(developmentPath, ".release-import-pending"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// Run before opening the development database or creating any services.
export function applyReleaseDataImport(developmentPath: string, required = true): boolean {
  const stage = join(developmentPath, ".release-import-pending");
  const retired = join(developmentPath, ".release-import-retired");
  const previousCleanup = existsSync(retired);
  if (previousCleanup) rmSync(retired, { recursive: true, force: true });
  if (!required && !existsSync(stage)) return previousCleanup;

  const managed = ["eda.db", "eda.db-wal", "eda.db-shm", "eda.db-journal", "secrets.vault"];
  const journal = join(stage, "original-files.json");
  const previous = (name: string) => join(stage, "previous-" + name);
  const finish = () => {
    // Detach the transaction before deleting its files. Recursive deletion can be interrupted.
    renameSync(stage, retired);
    rmSync(retired, { recursive: true, force: true });
  };
  const recordOriginal = (original: string[]) => {
    writeFileSync(journal + ".tmp", JSON.stringify(original), { mode: 0o600 });
    renameSync(journal + ".tmp", journal);
  };
  const rollback = (original: string[]) => {
    for (const name of managed) {
      const live = join(developmentPath, name);
      if (existsSync(previous(name))) renameSync(previous(name), live);
      else if (!original.includes(name)) rmSync(live, { force: true });
    }
    finish();
  };

  if (existsSync(journal)) {
    const original: unknown = JSON.parse(readFileSync(journal, "utf8"));
    if (!Array.isArray(original) || !original.every((name) => managed.includes(name)))
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.importReleaseData"),
        message: errorText("main.appData.releaseDataUnavailable"),
      });
    rollback(original);
    return true;
  }
  // Older installers wrote backups without a journal.
  if (managed.some((name) => existsSync(previous(name)))) {
    const movingOriginals = existsSync(join(stage, "eda.db"));
    const original = managed.filter(
      (name) =>
        existsSync(previous(name)) || (movingOriginals && existsSync(join(developmentPath, name))),
    );
    recordOriginal(original);
    rollback(original);
    return true;
  }
  if (!lstatSync(join(stage, "eda.db")).isFile())
    throw new GitError({
      kind: "invalid-input",
      operation: t("operations.importReleaseData"),
      message: errorText("main.appData.releaseDataUnavailable"),
    });
  const original = managed.filter((name) => existsSync(join(developmentPath, name)));
  recordOriginal(original);
  try {
    for (const name of original) renameSync(join(developmentPath, name), previous(name));
    for (const name of ["eda.db", "secrets.vault"]) {
      if (existsSync(join(stage, name))) renameSync(join(stage, name), join(developmentPath, name));
    }
  } catch (error) {
    rollback(original);
    throw error;
  }
  finish();
  return true;
}
