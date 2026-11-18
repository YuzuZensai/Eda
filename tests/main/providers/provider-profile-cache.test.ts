import { ProviderProfileCache } from "@main/providers/provider-profile-cache";
import { deferred } from "../../helpers/deferred";

it("does not restore a deleted profile when an older lookup finishes", async () => {
  const cache = new ProviderProfileCache<string>();
  const pending = deferred<string>();
  const loading = cache.get("account", () => pending.promise);

  cache.delete("account");
  pending.resolve("old profile");
  await loading;

  expect(cache.peek("account")).toBeNull();
  expect(await cache.get("account", async () => "new profile")).toBe("new profile");
});

it("preserves a profile explicitly updated during a lookup", async () => {
  const cache = new ProviderProfileCache<string>();
  const pending = deferred<string>();
  const loading = cache.get("account", () => pending.promise);

  cache.set("account", "new profile");
  pending.resolve("old profile");
  await loading;

  expect(cache.peek("account")).toBe("new profile");
});

it("refreshes an invalidated lookup instead of reusing its stale result", async () => {
  const cache = new ProviderProfileCache<string>();
  const pending = deferred<string>();
  const previous = cache.get("account", () => pending.promise);

  cache.delete("account");
  const current = cache.get("account", async () => "new profile");
  pending.resolve("old profile");
  await previous;

  expect(await current).toBe("new profile");
  expect(cache.peek("account")).toBe("new profile");
});

it("retains the fallback when a lookup throws before returning a promise", async () => {
  const cache = new ProviderProfileCache<string>();

  expect(
    await cache.get(
      "account",
      () => {
        throw new Error("offline");
      },
      "fallback",
    ),
  ).toBe("fallback");
  expect(cache.peek("account")).toBe("fallback");
});
