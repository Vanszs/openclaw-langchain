import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type DocsKbRecord = {
  docId: string;
  title: string;
  body: string;
  status: "active" | "superseded" | "deleted";
  version: number;
  createdAt: number;
  updatedAt: number;
  sourceType: "repo" | "docs" | "web" | "attachment" | "manual-note";
  provenance: {
    source: string;
    sessionKey?: string;
    messageId?: string;
    provider?: string;
    surface?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    channelId?: string;
    note?: string;
  };
};

function normalizeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function resolveDocsKbDir(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", "knowledge");
}

export function resolveDocsKbPaths(params: {
  workspaceDir: string;
  docId: string;
  version: number;
}): { markdownPath: string; metaPath: string } {
  const baseName = `${normalizeSegment(params.docId, crypto.randomUUID())}.v${Math.max(1, params.version)}`;
  const dir = resolveDocsKbDir(params.workspaceDir);
  return {
    markdownPath: path.join(dir, `${baseName}.md`),
    metaPath: path.join(dir, `${baseName}.json`),
  };
}

export async function readDocsKbRecord(absMetaPath: string): Promise<DocsKbRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(absMetaPath, "utf-8")) as DocsKbRecord;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.docId !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.body !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function listDocsKbRecords(
  workspaceDir: string,
): Promise<Array<{ absMetaPath: string; record: DocsKbRecord }>> {
  const root = resolveDocsKbDir(workspaceDir);
  const entries: Array<{ absMetaPath: string; record: DocsKbRecord }> = [];
  const dirEntries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of dirEntries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
      continue;
    }
    const absMetaPath = path.join(root, entry.name);
    const record = await readDocsKbRecord(absMetaPath);
    if (record) {
      entries.push({ absMetaPath, record });
    }
  }
  return entries;
}

export async function storeDocsKbRecord(params: {
  workspaceDir: string;
  title: string;
  body: string;
  sourceType: DocsKbRecord["sourceType"];
  provenance: DocsKbRecord["provenance"];
  docId?: string;
  nowMs?: number;
}): Promise<{ record: DocsKbRecord; superseded?: DocsKbRecord }> {
  const nowMs = params.nowMs ?? Date.now();
  const docId = normalizeSegment(params.docId ?? params.title, "knowledge-note");
  const existing = (await listDocsKbRecords(params.workspaceDir))
    .filter((entry) => entry.record.docId === docId)
    .toSorted((left, right) => right.record.version - left.record.version)[0];
  let superseded: DocsKbRecord | undefined;
  let nextVersion = 1;
  if (existing?.record.status === "active") {
    superseded = {
      ...existing.record,
      status: "superseded",
      updatedAt: nowMs,
    };
    await fs.writeFile(existing.absMetaPath, `${JSON.stringify(superseded, null, 2)}\n`, "utf-8");
    nextVersion = Math.max(1, existing.record.version + 1);
  } else if (existing) {
    nextVersion = Math.max(1, existing.record.version + 1);
  }
  const record: DocsKbRecord = {
    docId,
    title: params.title.trim() || docId,
    body: params.body.trim(),
    status: "active",
    version: nextVersion,
    createdAt: nowMs,
    updatedAt: nowMs,
    sourceType: params.sourceType,
    provenance: params.provenance,
  };
  const { markdownPath, metaPath } = resolveDocsKbPaths({
    workspaceDir: params.workspaceDir,
    docId,
    version: record.version,
  });
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.writeFile(markdownPath, `# ${record.title}\n\n${record.body.trim()}\n`, "utf-8");
  await fs.writeFile(metaPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return { record, ...(superseded ? { superseded } : {}) };
}
