import type { SecretStore } from "@main/secrets/secret-store";
import { secretKeys } from "@main/secrets/secret-store";
import { vi } from "vitest";

export class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();

  constructor(
    readonly available = true,
    readonly unavailableReason?: string,
  ) {}

  get = vi.fn(async (key: string) => this.values.get(key));
  set = vi.fn(async (key: string, value: string) => {
    this.values.set(key, value);
  });
  delete = vi.fn(async (key: string) => {
    this.values.delete(key);
  });
  deleteForIdentity = vi.fn(async (identityId: string) => {
    for (const key of this.values.keys())
      if (key.startsWith(secretKeys.identityPrefix(identityId))) this.values.delete(key);
  });
}
