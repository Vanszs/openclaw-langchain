import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../infra/file-lock.js";

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

const USER_MEMORY_FACTS_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 2_000,
    randomize: true,
  },
  stale: 10_000,
} as const;
const USER_MEMORY_FACT_MUTATION_TAILS = new Map<string, Promise<void>>();

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

export async function listActiveUserMemoryFacts(
  workspaceDir: string,
  opts?: { namespaces?: string[] },
): Promise<UserMemoryFactRecord[]> {
  const namespaceFilter =
    Array.isArray(opts?.namespaces) && opts.namespaces.length > 0
      ? new Set(opts.namespaces.map((entry) => normalizeSegment(entry, entry)))
      : null;
  const entries = await listUserMemoryFacts(workspaceDir);
  const active = entries
    .map((entry) => entry.record)
    .filter((record) => record.status === "active")
    .filter((record) => !namespaceFilter || namespaceFilter.has(record.namespace));
  return dedupeCanonicalActiveFacts(active);
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
  const factsDir = resolveUserMemoryFactsDir(params.workspaceDir);
  await fs.mkdir(factsDir, { recursive: true });
  const lockPath = path.join(factsDir, ".facts.lock");
  const mutationKey = path.resolve(factsDir);

  return await runSerializedUserMemoryMutation(mutationKey, async () =>
    withFileLock(lockPath, USER_MEMORY_FACTS_LOCK_OPTIONS, async () => {
      const facts = await listUserMemoryFacts(params.workspaceDir);
      const existingActive = facts
        .filter(
          (entry) =>
            entry.record.namespace === namespace &&
            entry.record.key === key &&
            entry.record.status === "active",
        )
        .toSorted((left, right) => compareFactRecords(left.record, right.record));
      let superseded: UserMemoryFactRecord | undefined;
      for (const entry of existingActive) {
        const nextSuperseded: UserMemoryFactRecord = {
          ...entry.record,
          status: "superseded",
          updatedAt: nowMs,
        };
        await fs.writeFile(entry.absPath, `${JSON.stringify(nextSuperseded, null, 2)}\n`, "utf-8");
        superseded = nextSuperseded;
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
    }),
  );
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

function buildFactIdentity(record: Pick<UserMemoryFactRecord, "namespace" | "key">): string {
  return `${record.namespace}::${record.key}`;
}

function compareFactRecords(left: UserMemoryFactRecord, right: UserMemoryFactRecord): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

function dedupeCanonicalActiveFacts(records: UserMemoryFactRecord[]): UserMemoryFactRecord[] {
  const newestByIdentity = new Map<string, UserMemoryFactRecord>();
  for (const record of records) {
    const identity = buildFactIdentity(record);
    const previous = newestByIdentity.get(identity);
    if (!previous || compareFactRecords(previous, record) < 0) {
      newestByIdentity.set(identity, record);
    }
  }
  return [...newestByIdentity.values()].toSorted(compareFactRecords);
}

async function runSerializedUserMemoryMutation<T>(
  mutationKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = USER_MEMORY_FACT_MUTATION_TAILS.get(mutationKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(fn);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  USER_MEMORY_FACT_MUTATION_TAILS.set(mutationKey, tail);
  try {
    return await current;
  } finally {
    if (USER_MEMORY_FACT_MUTATION_TAILS.get(mutationKey) === tail) {
      USER_MEMORY_FACT_MUTATION_TAILS.delete(mutationKey);
    }
  }
}
