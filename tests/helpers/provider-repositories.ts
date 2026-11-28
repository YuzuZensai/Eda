import { expect, type Mock } from "vitest";
import type { ProviderRepositoryPage } from "@shared/integrations/provider-repositories";

export async function checkSavedRepositoryAccess(
  ctx: {
    connect(): Promise<unknown>;
    profile: { id: string };
    other: { id: string };
    fetch: Mock<typeof globalThis.fetch>;
    service: { repositories(profileId: string): Promise<ProviderRepositoryPage> };
  },
  endpoint: string,
  token: string,
) {
  await ctx.connect();
  ctx.fetch.mockClear();
  ctx.fetch.mockResolvedValueOnce(Response.json([]));
  await expect(ctx.service.repositories(ctx.profile.id)).resolves.toEqual({
    repositories: [],
    nextPage: null,
  });
  expect(ctx.fetch).toHaveBeenCalledWith(
    expect.stringContaining(endpoint),
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer " + token }),
    }),
  );
  ctx.fetch.mockClear();
  await expect(ctx.service.repositories(ctx.other.id)).rejects.toThrow();
  expect(ctx.fetch).not.toHaveBeenCalled();
}
