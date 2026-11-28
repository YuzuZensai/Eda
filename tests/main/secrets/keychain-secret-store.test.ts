import { afterEach, expect, it, vi } from "vitest";
import { safeStorage } from "electron";
import { KeychainSecretStore } from "@main/secrets/keychain-secret-store";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { secretKeys } from "@main/secrets/secret-store";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString()),
    decryptStringAsync: vi.fn(async (value: Buffer) => ({
      result: value.toString(),
      shouldReEncrypt: false,
    })),
    getSelectedStorageBackend: vi.fn(),
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(["darwin", "linux", "win32"])(
  "reads existing credentials and persists updates with the async keychain on %s",
  async (platform) => {
    vi.stubGlobal("process", { platform });
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("gnome_libsecret");

    const root = await mkdtemp(join(tmpdir(), "eda-vault-async-"));

    try {
      const path = join(root, "vault");
      const key = secretKeys.sshPassphrase("work");

      await writeFile(
        path,
        JSON.stringify({ [key]: Buffer.from("saved secret").toString("base64") }),
      );

      const vault = await KeychainSecretStore.create(path);

      expect(vault.available).toBe(true);
      expect(await vault.get(key)).toBe("saved secret");

      await vault.set(key, "updated secret");

      expect(await vault.get(key)).toBe("updated secret");
      expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledOnce();
      expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
      expect(safeStorage.decryptString).not.toHaveBeenCalled();

      const saved = await readFile(path, "utf8");

      vi.mocked(safeStorage.decryptStringAsync).mockRejectedValueOnce(new Error("Locked"));

      expect(await vault.get(key)).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe(saved);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves the vault without trying the legacy path when macOS keychain access is rejected", async () => {
  vi.stubGlobal("process", { platform: "darwin" });
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockRejectedValueOnce(new Error("Denied"));

  const root = await mkdtemp(join(tmpdir(), "eda-vault-macos-denied-"));

  try {
    const path = join(root, "vault");
    const original = JSON.stringify({ credential: "saved ciphertext" });

    await writeFile(path, original);

    const vault = await KeychainSecretStore.create(path);

    expect(vault.available).toBe(false);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["win32", "darwin"] as const)(
  "starts secure storage on %s without calling the Linux-only backend API",
  async (platform) => {
    vi.stubGlobal("process", { platform });
    vi.mocked(safeStorage.getSelectedStorageBackend).mockImplementation(() => {
      throw new Error("Linux only");
    });

    const vault = await KeychainSecretStore.create("/unused/vault");

    expect(vault.available).toBe(true);
    expect(safeStorage.getSelectedStorageBackend).not.toHaveBeenCalled();
  },
);

it.each([
  ["basic_text", false],
  ["gnome_libsecret", true],
] as const)("reports Linux %s availability as %s", async (backend, available) => {
  vi.stubGlobal("process", { platform: "linux" });
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue(backend);
  const vault = await KeychainSecretStore.create("/unused/vault");
  expect(vault.available).toBe(available);
});

it("serializes vault changes, isolates same-host accounts, and deletes only one profile namespace", async () => {
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("gnome_libsecret");

  const root = await mkdtemp(join(tmpdir(), "eda-vault-"));

  try {
    const vault = await KeychainSecretStore.create(join(root, "vault"));
    const one = secretKeys.provider("work", "github", "GITHUB.COM", "one");

    expect(one).toBe(secretKeys.provider("work", "github", "github.com.", "one"));

    const two = secretKeys.provider("work", "github", "github.com", "two");
    const other = secretKeys.provider("home", "github", "github.com", "one");

    await Promise.all([
      vault.set(one, "one secret"),
      vault.set(two, "two secret"),
      vault.set(other, "home secret"),
    ]);
    expect(await vault.get(one)).toBe("one secret");
    expect(await vault.get(two)).toBe("two secret");

    await vault.deleteForIdentity("work");
    expect(await vault.get(one)).toBeUndefined();
    expect(await vault.get(two)).toBeUndefined();
    expect(await vault.get(other)).toBe("home secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses to overwrite an unreadable vault during profile deletion or credential save", async () => {
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("gnome_libsecret");

  const root = await mkdtemp(join(tmpdir(), "eda-vault-"));

  try {
    const path = join(root, "vault");

    const vault = await KeychainSecretStore.create(path);

    await writeFile(path, "{damaged");

    await expect(vault.deleteForIdentity("work")).rejects.toMatchObject({
      kind: "keychain-unavailable",
    });
    await expect(vault.set("identity:home:ssh-passphrase", "secret")).rejects.toThrow(/preserved/);
    expect(await readFile(path, "utf8")).toBe("{damaged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("clears queued vault writes and allows new credentials after a reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "eda-vault-reset-"));
  try {
    const path = join(root, "vault");
    const vault = await KeychainSecretStore.create(path);
    const pending = vault.set("old", "secret");
    await vault.clear();
    await pending;
    expect(await vault.get("old")).toBeUndefined();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await vault.set("new", "fresh");
    expect(await vault.get("new")).toBe("fresh");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("migrates legacy GitHub App vault entries across profiles, including orphans, preserving other credentials", async () => {
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("gnome_libsecret");
  const root = await mkdtemp(join(tmpdir(), "eda-oauth-vault-"));
  try {
    const path = join(root, "vault");
    const vault = await KeychainSecretStore.create(path);
    const legacy = secretKeys.provider("work", "github", "github.com", "7") + ":old";
    const orphan = secretKeys.provider("deleted-profile", "github", "github.com", "8") + ":orphan";
    const oauth = secretKeys.provider("work", "github-oauth", "github.com", "7") + ":new";
    const ssh = secretKeys.sshPassphrase("work");
    const signing = secretKeys.signingPassphrase("work");
    const otherHost = secretKeys.provider("work", "github", "enterprise.example.com", "7");
    for (const key of [legacy, orphan, oauth, ssh, signing, otherHost])
      await vault.set(key, "secret");
    await KeychainSecretStore.create(path);
    expect(await vault.get(legacy)).toBeUndefined();
    expect(await vault.get(orphan)).toBeUndefined();
    for (const key of [oauth, ssh, signing, otherHost]) expect(await vault.get(key)).toBe("secret");
    const migrated = await readFile(path, "utf8");
    await KeychainSecretStore.create(path);
    expect(await readFile(path, "utf8")).toBe(migrated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves an unreadable vault when OAuth migration fails", async () => {
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("gnome_libsecret");
  const root = await mkdtemp(join(tmpdir(), "eda-oauth-vault-"));
  try {
    const path = join(root, "vault");
    await writeFile(path, "damaged vault");
    await expect(KeychainSecretStore.create(path)).rejects.toMatchObject({
      kind: "keychain-unavailable",
    });
    expect(await readFile(path, "utf8")).toBe("damaged vault");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["darwin", "linux", "win32"])(
  "defers pending vault migrations on %s while storage is locked and runs them when it becomes available",
  async (platform) => {
    vi.stubGlobal("process", { platform });
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue("gnome_libsecret");

    const root = await mkdtemp(join(tmpdir(), "eda-vault-locked-"));

    try {
      const path = join(root, "vault");
      const legacy = secretKeys.provider("work", "github", "github.com", "7") + ":old";
      const original = JSON.stringify({ [legacy]: Buffer.from("legacy token").toString("base64") });

      await writeFile(path, original);

      vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValueOnce(false);

      expect((await KeychainSecretStore.create(path)).available).toBe(false);
      expect(await readFile(path, "utf8")).toBe(original);

      const unlocked = await KeychainSecretStore.create(path);

      expect(unlocked.available).toBe(true);
      expect(await unlocked.get(legacy)).toBeUndefined();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        __eda_migrations: JSON.stringify(["20261108000000_github_oauth"]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
