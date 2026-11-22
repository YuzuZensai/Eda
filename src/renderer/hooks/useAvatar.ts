import { useEffect, useState } from "react";
import type { AvatarImage } from "@shared/identity/avatar";

const requests = new Map<
  string,
  { expiresAt: number; result: Promise<AvatarImage>; url: string | null }
>();

function request(key: string, email: string, repositoryId?: string): Promise<AvatarImage> {
  const existing = requests.get(key);

  if (existing && existing.expiresAt > Date.now()) return existing.result;

  const result = Promise.resolve()
    .then(() => {
      const avatars = window.eda.avatars;
      return repositoryId ? avatars.getCommit(repositoryId, email) : avatars.get(email);
    })
    .catch(() => null)
    .then((response) => {
      const image = response?.ok
        ? response.value
        : { dataUrl: null, expiresAt: Date.now() + 5 * 60_000 };
      entry.expiresAt = image.expiresAt;
      entry.url = image.dataUrl;
      return image;
    });
  const entry = { expiresAt: Infinity, result, url: existing?.url ?? null };

  requests.delete(key);
  requests.set(key, entry);

  while (requests.size > 128) requests.delete(requests.keys().next().value!);

  return result;
}

export function useAvatar(email?: string, repositoryId?: string): string | undefined {
  const normalized = email?.trim().toLowerCase() ?? "";
  const key = repositoryId ? `${repositoryId}:${normalized}` : normalized;
  const [image, setImage] = useState<{ key: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!normalized) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const result = await request(key, normalized, repositoryId);
      if (!alive) return;
      setImage({ key, url: result.dataUrl });
      timer = setTimeout(() => void load(), Math.max(1000, result.expiresAt - Date.now()));
    };

    void load();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, normalized, repositoryId]);

  return (image?.key === key ? image.url : requests.get(key)?.url) ?? undefined;
}
