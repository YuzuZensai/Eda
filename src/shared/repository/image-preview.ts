export type ImagePreviewRequest = {
  repositoryId: string;
  path: string;
  oldPath?: string;
} & ({ kind: "working" | "staged" } | { kind: "commit"; oid: string });

export type ImagePreviewVersion =
  | { kind: "image"; path: string; mimeType: string; dataUrl: string; bytes: number }
  | { kind: "binary"; path: string; bytes: number }
  | { kind: "missing"; path: string }
  | { kind: "unavailable"; path: string; reason: string; bytes?: number };

export interface ImagePreview {
  before: ImagePreviewVersion;
  after: ImagePreviewVersion;
}

export function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(path);
}
