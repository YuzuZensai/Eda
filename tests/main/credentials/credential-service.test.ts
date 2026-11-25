import { describe, expect, it, vi } from "vitest";
import type { AgentStatus, UnlockKeyRequest } from "@shared/identity/ssh";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { MemorySecrets } from "../../helpers/memory-secrets";
import { secretKeys } from "@main/secrets/secret-store";
import { CredentialService } from "@main/credentials/credential-service";

const setup = (secrets = new MemorySecrets()) => {
  const identities = new IdentityRepository(openInMemoryDatabase());
  const identity = identities.create({
    name: "Work",
    gitName: "Eda",
    gitEmail: "dev@work.example",
    hue: 210,
    sshKeyPath: "/keys/work",
    signing: { format: "none", signCommits: false },
  });

  identities.setActiveId(identity.id);

  const unlocks: Array<{ request: UnlockKeyRequest; passphrase: string }> = [];
  const ssh = {
    async unlockKey(request: UnlockKeyRequest, passphrase: string): Promise<AgentStatus> {
      unlocks.push({ request, passphrase });
      return { available: true, keys: [] };
    },
  };

  return {
    identities,
    identity,
    secrets,
    ssh,
    unlocks,
    service: new CredentialService(identities, secrets, ssh),
  };
};

describe("CredentialService passphrase persistence", () => {
  it("retains the originating key and remembered credential during an asynchronous profile change", async () => {
    const ctx = setup();
    const home = ctx.identities.create({ ...ctx.identity, name: "Home", sshKeyPath: "/keys/home" });

    ctx.secrets.values.set(secretKeys.sshPassphrase(ctx.identity.id), "work secret");
    ctx.secrets.values.set(secretKeys.sshPassphrase(home.id), "home secret");

    const pending = ctx.service.unlockActiveKey({ remember: false });

    ctx.identities.setActiveId(home.id);
    await pending;
    expect(ctx.unlocks[0]).toMatchObject({
      request: { keyPath: "/keys/work" },
      passphrase: "work secret",
    });
    expect(ctx.secrets.values.get(secretKeys.sshPassphrase(home.id))).toBe("home secret");
  });

  it("reports availability and remembered state without returning the secret", async () => {
    const ctx = setup();
    ctx.secrets.values.set(secretKeys.sshPassphrase(ctx.identity.id), "never-return-me");
    const metadata = await ctx.service.getSecretMetadata();

    expect(metadata).toEqual({ available: true, remembered: true });
    expect(JSON.stringify(metadata)).not.toContain("never-return-me");
  });

  it("remembers only after a successful unlock and reuses it without renderer access", async () => {
    const ctx = setup();
    const unlock = vi.spyOn(ctx.ssh, "unlockKey").mockRejectedValueOnce(new Error("Unlock failed"));

    await expect(ctx.service.unlockActiveKey({ remember: true }, "failed secret")).rejects.toThrow(
      "Unlock failed",
    );
    expect(ctx.secrets.values.size).toBe(0);

    unlock.mockRestore();
    await ctx.service.unlockActiveKey({ lifetimeSeconds: 900, remember: true }, "s3cret");
    await ctx.service.unlockActiveKey({ remember: true });

    expect(ctx.secrets.values.get(secretKeys.sshPassphrase(ctx.identity.id))).toBe("s3cret");
    expect(ctx.unlocks.map((entry) => entry.passphrase)).toEqual(["s3cret", "s3cret"]);
  });

  it("keeps a remembered passphrase when an unlock reuses it without re-asserting remember", async () => {
    const ctx = setup();
    const key = secretKeys.sshPassphrase(ctx.identity.id);

    ctx.secrets.values.set(key, "s3cret");

    await ctx.service.unlockActiveKey({ remember: false });

    expect(ctx.secrets.values.get(key)).toBe("s3cret");
  });

  it("forgets a remembered passphrase only when the user supplies a new one without remember", async () => {
    const ctx = setup();
    const key = secretKeys.sshPassphrase(ctx.identity.id);

    ctx.secrets.values.set(key, "old");

    await ctx.service.unlockActiveKey({ remember: false }, "typed-instead");

    expect(ctx.secrets.values.has(key)).toBe(false);
  });

  it("forgets an identity passphrase without affecting key assignment", async () => {
    const ctx = setup();
    ctx.secrets.values.set(secretKeys.sshPassphrase(ctx.identity.id), "s3cret");
    await ctx.service.forgetActivePassphrase();

    expect(await ctx.service.getSecretMetadata()).toEqual({ available: true, remembered: false });
  });

  it("discloses unavailable keychain metadata and never persists", async () => {
    const ctx = setup(new MemorySecrets(false, "No keychain"));
    expect(await ctx.service.getSecretMetadata()).toEqual({
      available: false,
      remembered: false,
      reason: "No keychain",
    });
  });
});
