const CHAT_ATTACHMENT_EXTENSION_MIME: Record<string, string> = {
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".rst": "text/plain",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

const SUPPORTED_CHAT_ATTACHMENT_MIME_TYPES = new Set([
  "application/csv",
  "application/json",
  "application/ld+json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
]);

const SUPPORTED_CHAT_ATTACHMENT_EXTENSIONS = Object.keys(CHAT_ATTACHMENT_EXTENSION_MIME).filter(
  (ext) => !CHAT_ATTACHMENT_EXTENSION_MIME[ext]?.startsWith("image/"),
);

export const CHAT_ATTACHMENT_ACCEPT = ["image/*", ...SUPPORTED_CHAT_ATTACHMENT_EXTENSIONS].join(
  ",",
);

function normalizeMimeType(mimeType: string | null | undefined): string | null {
  if (typeof mimeType !== "string") {
    return null;
  }
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  return normalized || null;
}

function normalizeAttachmentExtension(fileName: string | null | undefined): string | null {
  if (typeof fileName !== "string") {
    return null;
  }
  const trimmed = fileName.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  const ext = dotIndex >= 0 ? trimmed.slice(dotIndex).toLowerCase() : "";
  return ext || null;
}

export function isImageChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return normalizeMimeType(mimeType)?.startsWith("image/") === true;
}

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return false;
  }
  return normalized.startsWith("image/") || SUPPORTED_CHAT_ATTACHMENT_MIME_TYPES.has(normalized);
}

export function resolveChatAttachmentMimeType(
  fileName: string | null | undefined,
  mimeType: string | null | undefined,
): string {
  const normalizedMime = normalizeMimeType(mimeType);
  if (normalizedMime && normalizedMime !== "application/octet-stream") {
    return normalizedMime;
  }
  const extension = normalizeAttachmentExtension(fileName);
  return (
    (extension && CHAT_ATTACHMENT_EXTENSION_MIME[extension]) ||
    normalizedMime ||
    "application/octet-stream"
  );
}

export function isSupportedChatAttachmentFile(file: {
  name?: string | null;
  type?: string | null;
}): boolean {
  if (isSupportedChatAttachmentMimeType(file.type)) {
    return true;
  }
  const extension = normalizeAttachmentExtension(file.name);
  return extension ? Object.hasOwn(CHAT_ATTACHMENT_EXTENSION_MIME, extension) : false;
}

export function getChatAttachmentLabel(attachment: {
  fileName?: string | null;
  mimeType?: string | null;
}): string {
  const fileName = attachment.fileName?.trim();
  if (fileName) {
    return fileName;
  }
  const mimeType = normalizeMimeType(attachment.mimeType);
  if (mimeType) {
    return mimeType;
  }
  return "attachment";
}
