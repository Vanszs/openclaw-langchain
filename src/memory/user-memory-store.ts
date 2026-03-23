import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type UserMemoryFactRecord = {
  id: string;
  namespace: string;
  key: string;
  value: string;
  status: "active" | "superseded" | "deleted";
  createdAt: number;
  updatedAt: number;
  supersedes?: string;
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

export function resolveUserMemoryFactsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", "facts");
}

export function resolveUserMemoryFactPath(params: {
  workspaceDir: string;
  namespace: string;
  id: string;
}): string {
  return path.join(
    resolveUserMemoryFactsDir(params.workspaceDir),
    normalizeSegment(params.namespace, "profile"),
    `${normalizeSegment(params.id, "fact")}.json`,
  );
}

export function buildUserMemoryFactId(params: { namespace: string; key: string }): string {
  return normalizeSegment(
    `${params.namespace}-${params.key}-${crypto.randomUUID()}`,
    crypto.randomUUID(),
  );
}

export async function readUserMemoryFactRecord(
  absPath: string,
): Promise<UserMemoryFactRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(absPath, "utf-8")) as UserMemoryFactRecord;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.id !== "string" ||
      typeof parsed.namespace !== "string" ||
      typeof parsed.key !== "string" ||
      typeof parsed.value !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function listUserMemoryFacts(
  workspaceDir: string,
): Promise<Array<{ absPath: string; record: UserMemoryFactRecord }>> {
  const root = resolveUserMemoryFactsDir(workspaceDir);
  const entries: Array<{ absPath: string; record: UserMemoryFactRecord }> = [];
  async function walk(dir: string): Promise<void> {
    const dirEntries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of dirEntries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
        continue;
      }
      const record = await readUserMemoryFactRecord(absPath);
      if (record) {
        entries.push({ absPath, record });
      }
    }
  }
  await walk(root);
  return entries;
}

export async function upsertUserMemoryFact(params: {
  workspaceDir: string;
  namespace: string;
  key: string;
  value: string;
  provenance: UserMemoryFactRecord["provenance"];
  nowMs?: number;
}): Promise<{ record: UserMemoryFactRecord; superseded?: UserMemoryFactRecord }> {
  const nowMs = params.nowMs ?? Date.now();
  const namespace = normalizeSegment(params.namespace, "profile");
  const key = normalizeSegment(params.key, "fact");
  const facts = await listUserMemoryFacts(params.workspaceDir);
  const existing = facts.find(
    (entry) =>
      entry.record.namespace === namespace &&
      entry.record.key === key &&
      entry.record.status === "active",
  );
  let superseded: UserMemoryFactRecord | undefined;
  if (existing) {
    superseded = {
      ...existing.record,
      status: "superseded",
      updatedAt: nowMs,
    };
    await fs.writeFile(existing.absPath, `${JSON.stringify(superseded, null, 2)}\n`, "utf-8");
  }
  const record: UserMemoryFactRecord = {
    id: buildUserMemoryFactId({ namespace, key }),
    namespace,
    key,
    value: params.value.trim(),
    status: "active",
    createdAt: nowMs,
    updatedAt: nowMs,
    ...(superseded ? { supersedes: superseded.id } : {}),
    provenance: params.provenance,
  };
  const filePath = resolveUserMemoryFactPath({
    workspaceDir: params.workspaceDir,
    namespace,
    id: record.id,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return { record, ...(superseded ? { superseded } : {}) };
}

export function formatUserMemoryFactForIndex(record: UserMemoryFactRecord): string {
  return [
    `# User Memory Fact`,
    `Namespace: ${record.namespace}`,
    `Key: ${record.key}`,
    `Status: ${record.status}`,
    "",
    record.value,
  ].join("\n");
}
