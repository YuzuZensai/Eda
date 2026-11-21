export const LFS_VERSION = "version https://git-lfs.github.com/spec/v1";

export function readLfsPointer(text: string) {
  if (text.length > 1024 || !text.startsWith(LFS_VERSION)) return null;
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines[0] !== LFS_VERSION) return null;
  const oid = lines.find((line) => /^oid sha256:[a-f0-9]{64}$/.test(line));
  const size = lines.find((line) => /^size [0-9]+$/.test(line));
  if (!oid || !size) return null;
  const bytes = Number(size.slice(5));
  return Number.isSafeInteger(bytes) ? { oid: oid.slice(4), bytes } : null;
}
