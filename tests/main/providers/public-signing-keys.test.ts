import { PublicSigningKeys, PUBLIC_KEY_LIMIT } from "@main/providers/public-signing-keys";

it("looks up explicit GitHub account hints without credentials or redirects", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("public key"));
  const keys = new PublicSigningKeys(request);
  const signal = new AbortController().signal;
  expect(await keys.find({ source: "github", account: "example" }, "ABC", signal)).toEqual({
    armoredKey: "public key",
    source: "https://github.com/example.gpg",
  });
  expect(request).toHaveBeenCalledWith("https://github.com/example.gpg", {
    signal,
    redirect: "error",
    credentials: "omit",
  });
  await expect(
    keys.find({ source: "github", account: "../keys" }, "ABC", signal),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});

it("requires an HTTPS keyserver and a long key identifier, and bounds downloaded bytes", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response("x".repeat(PUBLIC_KEY_LIMIT + 1)));
  const keys = new PublicSigningKeys(request);
  const signal = new AbortController().signal;
  for (const server of [
    "http://keys.example",
    "https://user:password@keys.example",
    "https://keys.example/redirect",
    "https://keys.example/?search=other",
  ]) {
    await expect(
      keys.find({ source: "keyserver", server }, "A".repeat(40), signal),
    ).rejects.toThrow();
  }
  await expect(
    keys.find({ source: "keyserver", server: "https://keys.example" }, "12345678", signal),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  await expect(
    keys.find({ source: "keyserver", server: "https://keys.example" }, "A".repeat(40), signal),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});
