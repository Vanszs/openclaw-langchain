import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { Document } from "@langchain/core/documents";
import { OpenAIEmbeddings } from "@langchain/openai";
import {
  MarkdownTextSplitter,
  RecursiveCharacterTextSplitter,
  type SupportedTextSplitterLanguage,
} from "@langchain/textsplitters";
import type { Where } from "chromadb";
import {
  loadSessionStore,
  readSessionMessages,
  resolveSessionStoreEntry,
  resolveStorePath,
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/core";
import type {
  MemoryDomain,
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
  MemoryVectorProbeStatus,
} from "openclaw/plugin-sdk/memory-core";
import {
  LANGCHAIN_VIRTUAL_ROOT,
  type LangchainAgentConfig,
  type LangchainMemoryDomain,
  type LangchainMemoryScope,
  type LangchainMemorySource,
  type LangchainPluginConfig,
  buildVirtualDocumentPath,
  makeStableId,
  resolveLangchainAgentConfig,
  resolveLangchainCollectionName,
  resolveLangchainPluginConfig,
  resolveLangchainPluginStorageState,
} from "./config.js";

type StoredDocumentMetadata = {
  source: LangchainMemorySource;
  path: string;
  domain?: LangchainMemoryDomain;
  title?: string;
  subject?: string;
  from?: string;
  to?: string;
  provider?: string;
  surface?: string;
  sessionKey?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  threadId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  originatingChannel?: string;
  originatingTo?: string;
  guildId?: string;
  channelName?: string;
  groupId?: string;
  groupSpace?: string;
  timestamp?: number;
  mimeType?: string;
  accessTag?: string;
  isGroup?: boolean;
  role?: string;
  chatType?: string;
};

type SourceDocument = {
  source: LangchainMemorySource;
  domain: LangchainMemoryDomain;
  path: string;
  absPath: string;
  title: string;
  content: string;
  hash: string;
  metadata: StoredDocumentMetadata;
};

type ChunkedSourceDocument = {
  id: string;
  pageContent: string;
  metadata: Record<string, string | number | boolean>;
};

type ManifestEntry = {
  domain: LangchainMemoryDomain;
  source: LangchainMemorySource;
  path: string;
  hash: string;
  ids: string[];
  chunks: number;
};

type IndexManifest = {
  version: 1;
  documents: Record<string, ManifestEntry>;
};

type LangchainStatusFile = {
  version: 1;
  pluginId: "memory-langchain";
  agentId: string;
  updatedAt: number;
  backendReachable: boolean;
  backendError?: string;
  lastError?: string;
  lastSyncAt?: number;
  queueDepth: number;
  files: number;
  chunks: number;
  sources: LangchainMemorySource[];
  extraPaths: string[];
  roots: string[];
  workspaceDir: string;
  chromaUrl: string;
  collectionName: string;
  sourceCounts: Array<{ source: LangchainMemorySource; files: number; chunks: number }>;
  collections?: Partial<Record<LangchainMemoryDomain, string>>;
};

type SyncReason = "cli" | "service";
const EMPTY_MANIFEST: IndexManifest = {
  version: 1,
  documents: {},
};
const DOMAIN_ORDER: LangchainMemoryDomain[] = ["user_memory", "docs_kb", "history"];

const TEXT_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".rst",
  ".scala",
  ".sol",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".html"]);
const SESSION_TRANSCRIPT_FALLBACK_DIR = "sessions-transcripts";
const OPENROUTER_EMBEDDINGS_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_HEADERS = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
} as const;
const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "tmp",
]);

function isTruthy(value: unknown): value is true {
  return value === true;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  return undefined;
}

function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value >= 0 && value <= 1) {
    return value;
  }
  return 1 / (1 + Math.max(0, value));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeSnippet(text: string): string {
  return text
    .replace(/<\s*\/?(system|assistant|developer|tool|function|relevant-memories)\b/gi, "[tag]")
    .replace(/\r\n/g, "\n");
}

function resolveDomainSources(domain: LangchainMemoryDomain): LangchainMemorySource[] {
  if (domain === "user_memory") {
    return ["memory"];
  }
  if (domain === "docs_kb") {
    return ["docs", "repo"];
  }
  return ["chat", "email", "sessions"];
}

function inferDomainFromSources(
  sources: LangchainMemorySource[] | undefined,
): LangchainMemoryDomain | undefined {
  if (!sources || sources.length === 0) {
    return undefined;
  }
  const unique = Array.from(new Set(sources));
  if (unique.length === 1 && unique[0] === "memory") {
    return "user_memory";
  }
  if (unique.every((source) => source === "docs" || source === "repo")) {
    return "docs_kb";
  }
  if (unique.every((source) => source === "chat" || source === "email" || source === "sessions")) {
    return "history";
  }
  return undefined;
}

function isUserMemoryPath(relPath: string): boolean {
  return relPath.trim().replace(/\\/g, "/").startsWith("memory/facts/");
}

function isDocsKbPath(relPath: string): boolean {
  return relPath.trim().replace(/\\/g, "/").startsWith("memory/knowledge/");
}

function isHistoryPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, "/");
  return (
    normalized.startsWith(`${LANGCHAIN_VIRTUAL_ROOT}/chat/`) ||
    normalized.startsWith(`${LANGCHAIN_VIRTUAL_ROOT}/email/`) ||
    normalized.startsWith(`${LANGCHAIN_VIRTUAL_ROOT}/sessions/`) ||
    normalized.startsWith(`${LANGCHAIN_VIRTUAL_ROOT}/${SESSION_TRANSCRIPT_FALLBACK_DIR}/`)
  );
}

function inferDomainFromPath(relPath: string): LangchainMemoryDomain | undefined {
  if (isUserMemoryPath(relPath)) {
    return "user_memory";
  }
  if (isDocsKbPath(relPath)) {
    return "docs_kb";
  }
  if (isHistoryPath(relPath)) {
    return "history";
  }
  return undefined;
}

function buildChromaWhereFilter(filter?: Record<string, string>): Where | undefined {
  if (!filter) {
    return undefined;
  }
  const entries = Object.entries(filter).filter(([, value]) => value.trim().length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    const [key, value] = entries[0]!;
    return { [key]: value };
  }
  return {
    $and: entries.map(([key, value]) => ({ [key]: value })),
  };
}

function toWorkspaceRelativePath(workspaceDir: string, absPath: string): string {
  return path.relative(workspaceDir, absPath).split(path.sep).join("/");
}

function collectDistinctiveQueryNeedles(query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const needles = new Set<string>([normalizedQuery]);
  for (const token of query.match(/[A-Za-z0-9_-]{4,}/g) ?? []) {
    if (!/[A-Z0-9_-]/.test(token)) {
      continue;
    }
    needles.add(token.toLowerCase());
  }
  return Array.from(needles);
}

async function collectExactUserMemoryMatches(params: {
  workspaceDir: string;
  query: string;
  maxResults: number;
  dedupe: Set<string>;
  mapped: MemorySearchResult[];
}): Promise<void> {
  const needles = collectDistinctiveQueryNeedles(params.query);
  if (needles.length === 0) {
    return;
  }
  const candidateFiles = await listFilesRecursive(
    path.join(params.workspaceDir, "memory", "facts"),
    (absPath) => absPath.toLowerCase().endsWith(".json"),
  );
  for (const absPath of candidateFiles) {
    if (params.mapped.length >= params.maxResults) {
      return;
    }
    const record = await readUserMemoryFactRecord(absPath);
    if (!record || record.status !== "active") {
      continue;
    }
    const content = formatUserMemoryFactForIndex(record);
    const normalizedContent = content.toLowerCase();
    const matchedNeedle = needles.find((needle) => normalizedContent.includes(needle));
    if (!matchedNeedle) {
      continue;
    }
    const matchIndex = normalizedContent.indexOf(matchedNeedle);
    if (matchIndex < 0) {
      continue;
    }
    const relPath = toWorkspaceRelativePath(params.workspaceDir, absPath);
    const lineStarts = computeLineStarts(content);
    const rows = content.split(/\r?\n/);
    const startLine = lineNumberFromIndex(lineStarts, matchIndex);
    const endLine = Math.min(rows.length, startLine + 2);
    const snippet = sanitizeSnippet(rows.slice(startLine - 1, endLine).join("\n")).trim();
    if (!snippet) {
      continue;
    }
    const dedupeKey = `${relPath}:${startLine}:${endLine}:${snippet}`;
    if (params.dedupe.has(dedupeKey)) {
      continue;
    }
    params.dedupe.add(dedupeKey);
    params.mapped.push({
      path: relPath,
      startLine,
      endLine,
      score: 0.99,
      snippet,
      source: "memory",
      domain: "user_memory",
    });
  }
}

type UserMemoryFactRecord = {
  id: string;
  namespace: string;
  key: string;
  value: string;
  status: "active" | "superseded" | "deleted";
};

type DocsKbRecord = {
  docId: string;
  title: string;
  body: string;
  status: "active" | "superseded" | "deleted";
  version: number;
  sourceType: "repo" | "docs" | "web" | "attachment" | "manual-note";
};

async function readUserMemoryFactRecord(absPath: string): Promise<UserMemoryFactRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(absPath, "utf-8")) as UserMemoryFactRecord;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.id !== "string" ||
      typeof parsed.namespace !== "string" ||
      typeof parsed.key !== "string" ||
      typeof parsed.value !== "string" ||
      typeof parsed.status !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function readDocsKbRecord(absPath: string): Promise<DocsKbRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(absPath, "utf-8")) as DocsKbRecord;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.docId !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.body !== "string" ||
      typeof parsed.status !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function formatUserMemoryFactForIndex(record: UserMemoryFactRecord): string {
  return [
    "# User Memory Fact",
    `Namespace: ${record.namespace}`,
    `Key: ${record.key}`,
    `Status: ${record.status}`,
    "",
    record.value.trim(),
  ].join("\n");
}

function buildDomainManifestPath(
  plugin: Pick<LangchainPluginConfig, "manifestPath">,
  domain: LangchainMemoryDomain,
): string {
  return plugin.manifestPath.replace(/\.json$/i, `.${domain}.json`);
}

function ensureDirSync(dir: string): void {
  fsSync.mkdirSync(dir, { recursive: true });
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJsonFile<T>(pathname: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(pathname, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(pathname: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(pathname));
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readPendingQueueDepth(dir: string): number {
  try {
    return fsSync.readdirSync(dir).filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function readFailedQueueDepth(queueDir: string): number {
  try {
    const failedDir = path.join(queueDir, "failed");
    return fsSync.readdirSync(failedDir).filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function listFilesRecursive(
  dir: string,
  filter?: (absPath: string) => boolean,
): Promise<string[]> {
  const results: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fsSync.Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (filter && !filter(absPath)) {
        continue;
      }
      results.push(absPath);
    }
  }
  return results.toSorted();
}

function isIndexableWorkspaceFile(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(ext);
}

function classifyWorkspaceSource(
  absPath: string,
  workspaceDir: string,
): LangchainMemorySource | null {
  const rel = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) {
    return null;
  }
  if (rel === "MEMORY.md" || rel === "memory.md" || rel.startsWith("memory/")) {
    return null;
  }
  const ext = path.extname(absPath).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(ext)) {
    return null;
  }
  return DOC_EXTENSIONS.has(ext) ? "docs" : "repo";
}

function resolveSplitter(pathname: string, cfg: LangchainPluginConfig) {
  const ext = path.extname(pathname).toLowerCase();
  if (ext === ".md" || ext === ".mdx" || ext === ".rst") {
    return new MarkdownTextSplitter({
      chunkSize: cfg.chunkSize,
      chunkOverlap: cfg.chunkOverlap,
    });
  }
  const language = resolveLanguage(pathname);
  if (language) {
    return RecursiveCharacterTextSplitter.fromLanguage(language, {
      chunkSize: cfg.chunkSize,
      chunkOverlap: cfg.chunkOverlap,
    });
  }
  return new RecursiveCharacterTextSplitter({
    chunkSize: cfg.chunkSize,
    chunkOverlap: cfg.chunkOverlap,
  });
}

function resolveLanguage(pathname: string): SupportedTextSplitterLanguage | null {
  const ext = path.extname(pathname).toLowerCase();
  switch (ext) {
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
    case ".h":
      return "cpp";
    case ".go":
      return "go";
    case ".java":
      return "java";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".tsx":
      return "js";
    case ".php":
      return "php";
    case ".proto":
      return "proto";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".rs":
      return "rust";
    case ".scala":
      return "scala";
    case ".swift":
      return "swift";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".html":
      return "html";
    case ".sol":
      return "sol";
    default:
      return null;
  }
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineNumberFromIndex(starts: number[], charIndex: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= charIndex) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(1, high + 1);
}

async function chunkDocument(
  document: SourceDocument,
  cfg: LangchainPluginConfig,
): Promise<ChunkedSourceDocument[]> {
  const splitter = resolveSplitter(document.absPath, cfg);
  const splitDocs = await splitter.createDocuments([document.content]);
  const lineStarts = computeLineStarts(document.content);
  const chunks: ChunkedSourceDocument[] = [];
  let searchOffset = 0;
  for (let index = 0; index < splitDocs.length; index += 1) {
    const chunkText = splitDocs[index]?.pageContent?.trim();
    if (!chunkText) {
      continue;
    }
    const locatedAt = document.content.indexOf(chunkText, searchOffset);
    const charStart = locatedAt >= 0 ? locatedAt : Math.min(searchOffset, document.content.length);
    const charEnd = Math.max(charStart, charStart + chunkText.length);
    const startLine = lineNumberFromIndex(lineStarts, charStart);
    const endLine = lineNumberFromIndex(lineStarts, Math.max(charStart, charEnd - 1));
    searchOffset = Math.max(charStart + 1, charEnd - Math.max(1, cfg.chunkOverlap));
    chunks.push({
      id: makeStableId([document.domain, document.source, document.path, index]),
      pageContent: chunkText,
      metadata: {
        source: document.source,
        domain: document.domain,
        path: document.path,
        title: document.title,
        startLine,
        endLine,
        ...(typeof document.metadata.sessionKey === "string"
          ? { sessionKey: document.metadata.sessionKey }
          : {}),
        ...(typeof document.metadata.channelId === "string"
          ? { channelId: document.metadata.channelId }
          : {}),
        ...(typeof document.metadata.from === "string" ? { from: document.metadata.from } : {}),
        ...(typeof document.metadata.to === "string" ? { to: document.metadata.to } : {}),
        ...(typeof document.metadata.subject === "string"
          ? { subject: document.metadata.subject }
          : {}),
        ...(typeof document.metadata.provider === "string"
          ? { provider: document.metadata.provider }
          : {}),
        ...(typeof document.metadata.surface === "string"
          ? { surface: document.metadata.surface }
          : {}),
        ...(typeof document.metadata.accountId === "string"
          ? { accountId: document.metadata.accountId }
          : {}),
        ...(typeof document.metadata.conversationId === "string"
          ? { conversationId: document.metadata.conversationId }
          : {}),
        ...(typeof document.metadata.messageId === "string"
          ? { messageId: document.metadata.messageId }
          : {}),
        ...(typeof document.metadata.threadId === "string"
          ? { threadId: document.metadata.threadId }
          : {}),
        ...(typeof document.metadata.senderId === "string"
          ? { senderId: document.metadata.senderId }
          : {}),
        ...(typeof document.metadata.senderName === "string"
          ? { senderName: document.metadata.senderName }
          : {}),
        ...(typeof document.metadata.senderUsername === "string"
          ? { senderUsername: document.metadata.senderUsername }
          : {}),
        ...(typeof document.metadata.senderE164 === "string"
          ? { senderE164: document.metadata.senderE164 }
          : {}),
        ...(typeof document.metadata.originatingChannel === "string"
          ? { originatingChannel: document.metadata.originatingChannel }
          : {}),
        ...(typeof document.metadata.originatingTo === "string"
          ? { originatingTo: document.metadata.originatingTo }
          : {}),
        ...(typeof document.metadata.guildId === "string"
          ? { guildId: document.metadata.guildId }
          : {}),
        ...(typeof document.metadata.channelName === "string"
          ? { channelName: document.metadata.channelName }
          : {}),
        ...(typeof document.metadata.groupId === "string"
          ? { groupId: document.metadata.groupId }
          : {}),
        ...(typeof document.metadata.groupSpace === "string"
          ? { groupSpace: document.metadata.groupSpace }
          : {}),
        ...(typeof document.metadata.timestamp === "number"
          ? { timestamp: document.metadata.timestamp }
          : {}),
        ...(typeof document.metadata.mimeType === "string"
          ? { mimeType: document.metadata.mimeType }
          : {}),
        ...(typeof document.metadata.accessTag === "string"
          ? { accessTag: document.metadata.accessTag }
          : {}),
        ...(typeof document.metadata.role === "string" ? { role: document.metadata.role } : {}),
        ...(typeof document.metadata.chatType === "string"
          ? { chatType: document.metadata.chatType }
          : {}),
        ...(typeof document.metadata.isGroup === "boolean"
          ? { isGroup: document.metadata.isGroup }
          : {}),
      },
    });
  }
  return chunks;
}

function countBySource(docs: SourceDocument[], chunks: ChunkedSourceDocument[]) {
  const bySource = new Map<LangchainMemorySource, { files: number; chunks: number }>();
  for (const doc of docs) {
    const current = bySource.get(doc.source) ?? { files: 0, chunks: 0 };
    current.files += 1;
    bySource.set(doc.source, current);
  }
  for (const chunk of chunks) {
    const source = chunk.metadata.source as LangchainMemorySource;
    const current = bySource.get(source) ?? { files: 0, chunks: 0 };
    current.chunks += 1;
    bySource.set(source, current);
  }
  return Array.from(bySource.entries())
    .map(([source, value]) => ({ source, ...value }))
    .toSorted((left, right) => left.source.localeCompare(right.source));
}

function buildManifestKey(
  domain: LangchainMemoryDomain,
  source: LangchainMemorySource,
  relPath: string,
): string {
  return `${domain}::${source}::${relPath}`;
}

function buildSessionTranscriptFallbackPath(fileName: string): string {
  return path.posix.join(LANGCHAIN_VIRTUAL_ROOT, SESSION_TRANSCRIPT_FALLBACK_DIR, fileName);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function loadStoredDocumentMetadata(absPath: string): Promise<StoredDocumentMetadata> {
  const metaPath = absPath.replace(/\.md$/i, ".json");
  return await readJsonFile<StoredDocumentMetadata>(metaPath, {
    source: "chat",
    path: path.basename(absPath),
    domain: "history",
  });
}

async function buildDocumentFromFile(params: {
  source: LangchainMemorySource;
  domain: LangchainMemoryDomain;
  absPath: string;
  workspaceDir: string;
  virtualRoot?: string;
}): Promise<SourceDocument | null> {
  const content = await fs.readFile(params.absPath, "utf-8").catch(() => null);
  if (!content || !content.trim()) {
    return null;
  }
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const relPath = params.virtualRoot
    ? path.posix.join(params.virtualRoot, path.basename(params.absPath))
    : path.relative(params.workspaceDir, params.absPath).replace(/\\/g, "/");
  const metadata =
    params.virtualRoot !== undefined
      ? await loadStoredDocumentMetadata(params.absPath)
      : ({
          source: params.source,
          path: relPath,
          domain: params.domain,
          title: path.basename(params.absPath),
        } satisfies StoredDocumentMetadata);
  return {
    source: params.source,
    domain: params.domain,
    path: metadata.path || relPath,
    absPath: params.absPath,
    title: metadata.title || path.basename(params.absPath),
    content,
    hash,
    metadata: {
      ...metadata,
      source: params.source,
      domain: metadata.domain ?? params.domain,
      path: metadata.path || relPath,
    },
  };
}

async function buildDocumentFromText(params: {
  source: LangchainMemorySource;
  domain: LangchainMemoryDomain;
  absPath: string;
  relPath: string;
  title: string;
  content: string;
  metadata?: Partial<StoredDocumentMetadata>;
}): Promise<SourceDocument | null> {
  const content = params.content.trim();
  if (!content) {
    return null;
  }
  return {
    source: params.source,
    domain: params.domain,
    path: params.relPath,
    absPath: params.absPath,
    title: params.title,
    content,
    hash: crypto.createHash("sha256").update(content).digest("hex"),
    metadata: {
      source: params.source,
      domain: params.domain,
      path: params.relPath,
      title: params.title,
      ...params.metadata,
    },
  };
}

async function collectCanonicalUserMemoryDocuments(
  agent: LangchainAgentConfig,
): Promise<SourceDocument[]> {
  const docs: SourceDocument[] = [];
  const files = await listFilesRecursive(
    path.join(agent.workspaceDir, "memory", "facts"),
    (absPath) => path.extname(absPath).toLowerCase() === ".json",
  );
  for (const absPath of files) {
    const record = await readUserMemoryFactRecord(absPath);
    if (!record || record.status !== "active") {
      continue;
    }
    const relPath = path.relative(agent.workspaceDir, absPath).replace(/\\/g, "/");
    const doc = await buildDocumentFromText({
      source: "memory",
      domain: "user_memory",
      absPath,
      relPath,
      title: `${record.namespace}.${record.key}`,
      content: formatUserMemoryFactForIndex(record),
      metadata: {
        subject: `${record.namespace}.${record.key}`,
      },
    });
    if (doc) {
      docs.push(doc);
    }
  }
  return docs;
}

async function collectDocsKnowledgeDocuments(
  agent: LangchainAgentConfig,
): Promise<SourceDocument[]> {
  const docs: SourceDocument[] = [];
  const files = await listFilesRecursive(
    path.join(agent.workspaceDir, "memory", "knowledge"),
    (absPath) => path.extname(absPath).toLowerCase() === ".json",
  );
  for (const absMetaPath of files) {
    const record = await readDocsKbRecord(absMetaPath);
    if (!record || record.status !== "active") {
      continue;
    }
    const markdownPath = absMetaPath.replace(/\.json$/i, ".md");
    const content =
      (await fs.readFile(markdownPath, "utf-8").catch(() => record.body)) ?? record.body;
    const relPath = path.relative(agent.workspaceDir, markdownPath).replace(/\\/g, "/");
    const doc = await buildDocumentFromText({
      source: "docs",
      domain: "docs_kb",
      absPath: markdownPath,
      relPath,
      title: record.title,
      content,
      metadata: {
        subject: record.title,
      },
    });
    if (doc) {
      docs.push(doc);
    }
  }
  return docs;
}

async function collectWorkspaceDocuments(agent: LangchainAgentConfig): Promise<SourceDocument[]> {
  const docs: SourceDocument[] = [];
  const inputs = Array.from(new Set([...agent.roots, ...agent.extraPaths]));
  for (const input of inputs) {
    if (!fsSync.existsSync(input)) {
      continue;
    }
    const stat = await fs.stat(input).catch(() => null);
    if (!stat) {
      continue;
    }
    if (stat.isDirectory()) {
      const files = await listFilesRecursive(input, isIndexableWorkspaceFile);
      for (const absPath of files) {
        const source = classifyWorkspaceSource(absPath, agent.workspaceDir);
        if (!source) {
          continue;
        }
        const doc = await buildDocumentFromFile({
          source,
          domain: "docs_kb",
          absPath,
          workspaceDir: agent.workspaceDir,
        });
        if (doc) {
          docs.push(doc);
        }
      }
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const source = classifyWorkspaceSource(input, agent.workspaceDir);
    if (!source) {
      continue;
    }
    const doc = await buildDocumentFromFile({
      source,
      domain: "docs_kb",
      absPath: input,
      workspaceDir: agent.workspaceDir,
    });
    if (doc) {
      docs.push(doc);
    }
  }
  return docs;
}

async function collectStoredDocuments(params: {
  source: LangchainMemorySource;
  plugin: LangchainPluginConfig;
  agent: LangchainAgentConfig;
}): Promise<SourceDocument[]> {
  const dir = path.join(params.plugin.documentsDir, params.agent.agentId, params.source);
  const files = await listFilesRecursive(dir, (absPath) => absPath.endsWith(".md"));
  const docs: SourceDocument[] = [];
  for (const absPath of files) {
    const doc = await buildDocumentFromFile({
      source: params.source,
      domain: "history",
      absPath,
      workspaceDir: params.agent.workspaceDir,
      virtualRoot: buildVirtualDocumentPath(params.source, ""),
    });
    if (!doc) {
      continue;
    }
    const fileName = path.basename(absPath);
    doc.path = buildVirtualDocumentPath(params.source, fileName);
    doc.metadata.path = doc.path;
    docs.push(doc);
  }
  return docs;
}

function extractTextFromTranscriptMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.content === "string") {
    return record.content.trim();
  }
  if (Array.isArray(record.content)) {
    return record.content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const block = entry as Record<string, unknown>;
        if (typeof block.text === "string") {
          return block.text.trim();
        }
        if (typeof block.content === "string") {
          return block.content.trim();
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

async function collectSessionTranscriptFallbackDocuments(
  agent: LangchainAgentConfig,
): Promise<SourceDocument[]> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agent.agentId);
  const files = await listFilesRecursive(sessionsDir, (absPath) => absPath.endsWith(".jsonl"));
  const docs: SourceDocument[] = [];
  for (const absPath of files) {
    const sessionId = path.basename(absPath, path.extname(absPath));
    const content = buildSessionTranscriptFallbackContent(sessionId, absPath);
    if (!content) {
      continue;
    }
    docs.push({
      source: "sessions",
      domain: "history",
      path: buildSessionTranscriptFallbackPath(path.basename(absPath)),
      absPath,
      title: sessionId,
      content,
      hash: crypto.createHash("sha256").update(content).digest("hex"),
      metadata: {
        source: "sessions",
        domain: "history",
        path: buildSessionTranscriptFallbackPath(path.basename(absPath)),
        title: sessionId,
        sessionKey: sessionId,
      },
    });
  }
  return docs;
}

function buildSessionTranscriptFallbackContent(
  sessionId: string,
  sessionFile: string,
): string | null {
  const messages = readSessionMessages(sessionId, undefined, sessionFile);
  const body = messages
    .map((message) => {
      const role =
        message &&
        typeof message === "object" &&
        typeof (message as { role?: unknown }).role === "string"
          ? String((message as { role: string }).role)
          : "unknown";
      const text = extractTextFromTranscriptMessage(message);
      return text ? `## ${role}\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!body) {
    return null;
  }
  return `# Session transcript fallback\nSession: ${sessionId}\n\n${body}\n`;
}

function resolveSessionFallbackMetadata(
  cfg: OpenClawConfig,
  agentId: string,
  sessionKey: string,
): Partial<StoredDocumentMetadata> {
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const { existing } = resolveSessionStoreEntry({ store, sessionKey });
    if (!existing) {
      return {};
    }
    const origin = existing.origin;
    const delivery = existing.deliveryContext;
    return {
      channelId:
        normalizeText(delivery?.channel ?? existing.lastChannel ?? existing.channel) ||
        normalizeText(origin?.provider ?? origin?.surface) ||
        undefined,
      accountId:
        normalizeText(delivery?.accountId ?? existing.lastAccountId ?? origin?.accountId) ||
        undefined,
      conversationId: normalizeText(delivery?.to ?? existing.lastTo ?? origin?.to) || undefined,
      threadId: normalizeThreadId(delivery?.threadId ?? existing.lastThreadId ?? origin?.threadId),
      senderId: normalizeText(origin?.from) || undefined,
      provider: normalizeText(origin?.provider) || undefined,
      surface: normalizeText(origin?.surface) || undefined,
      groupId: normalizeText(existing.groupId) || undefined,
      channelName: normalizeText(existing.groupChannel) || undefined,
      title: normalizeText(existing.subject) || sessionKey,
      accessTag: `session:${sessionKey.toLowerCase()}`,
    };
  } catch {
    return {};
  }
}

async function collectDocuments(params: {
  cfg: OpenClawConfig;
  plugin: LangchainPluginConfig;
  agent: LangchainAgentConfig;
}): Promise<SourceDocument[]> {
  const docs: SourceDocument[] = [];
  if (params.agent.sources.includes("memory")) {
    docs.push(...(await collectCanonicalUserMemoryDocuments(params.agent)));
  }
  if (params.agent.sources.includes("repo") || params.agent.sources.includes("docs")) {
    docs.push(...(await collectDocsKnowledgeDocuments(params.agent)));
    const workspaceDocs = await collectWorkspaceDocuments(params.agent);
    docs.push(
      ...workspaceDocs.filter((doc) =>
        doc.source === "repo"
          ? params.agent.sources.includes("repo")
          : params.agent.sources.includes("docs"),
      ),
    );
  }
  if (params.agent.sources.includes("chat")) {
    docs.push(...(await collectStoredDocuments({ ...params, source: "chat" })));
  }
  if (params.agent.sources.includes("email")) {
    docs.push(...(await collectStoredDocuments({ ...params, source: "email" })));
  }
  if (params.agent.sources.includes("sessions")) {
    const storedSessions = await collectStoredDocuments({ ...params, source: "sessions" });
    docs.push(...storedSessions);
    if (storedSessions.length === 0) {
      const fallbackDocs = await collectSessionTranscriptFallbackDocuments(params.agent);
      docs.push(
        ...fallbackDocs.map((doc) => ({
          ...doc,
          metadata: {
            ...doc.metadata,
            ...resolveSessionFallbackMetadata(params.cfg, params.agent.agentId, doc.title),
          },
        })),
      );
    }
  }
  const deduped = new Map<string, SourceDocument>();
  for (const doc of docs) {
    deduped.set(buildManifestKey(doc.domain, doc.source, doc.path), doc);
  }
  return Array.from(deduped.values()).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function resolveReadPath(params: {
  agent: LangchainAgentConfig;
  plugin: LangchainPluginConfig;
  relPath: string;
}): string | null {
  const trimmed = params.relPath.trim().replace(/\\/g, "/");
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith(`${LANGCHAIN_VIRTUAL_ROOT}/`)) {
    const [, source, ...rest] = trimmed.split("/");
    if (!source || rest.length === 0) {
      return null;
    }
    if (source === SESSION_TRANSCRIPT_FALLBACK_DIR) {
      const sessionsDir = resolveSessionTranscriptsDirForAgent(params.agent.agentId);
      const absPath = path.join(sessionsDir, rest.join("/"));
      if (!isWithinRoot(sessionsDir, absPath)) {
        return null;
      }
      return absPath;
    }
    const absPath = path.join(
      params.plugin.documentsDir,
      params.agent.agentId,
      source,
      rest.join("/"),
    );
    if (!isWithinRoot(params.plugin.documentsDir, absPath)) {
      return null;
    }
    return absPath;
  }
  const absPath = path.resolve(params.agent.workspaceDir, trimmed);
  if (!isWithinRoot(params.agent.workspaceDir, absPath)) {
    return null;
  }
  return absPath;
}

async function deleteIds(store: Chroma, ids: string[]): Promise<void> {
  const pending = [...ids];
  while (pending.length > 0) {
    const batch = pending.splice(0, 100);
    await store.delete({ ids: batch });
  }
}

export class LangchainMemoryManager implements MemorySearchManager {
  constructor(
    private readonly cfg: OpenClawConfig,
    private readonly agentId: string,
    private readonly workspaceDir: string,
    private readonly logger?: PluginLogger,
  ) {}

  private async resolveRuntime() {
    const plugin = await resolveLangchainPluginConfig({
      cfg: this.cfg,
      logger: this.logger,
    });
    const agent = resolveLangchainAgentConfig({
      cfg: this.cfg,
      agentId: this.agentId,
      workspaceDir: this.workspaceDir,
    });
    return { plugin, agent };
  }

  private async createEmbeddings(plugin: LangchainPluginConfig) {
    if (plugin.embeddingProvider !== "openai" && plugin.embeddingProvider !== "openrouter") {
      throw new Error(
        `memory-langchain only supports embeddingProvider in [openai, openrouter] (received ${plugin.embeddingProvider})`,
      );
    }
    if (!plugin.apiKey) {
      throw new Error(plugin.apiKeyUnresolvedReason ?? "embedding API key missing");
    }
    const configuration =
      plugin.embeddingProvider === "openrouter"
        ? {
            baseURL: OPENROUTER_EMBEDDINGS_BASE_URL,
            defaultHeaders: OPENROUTER_DEFAULT_HEADERS,
          }
        : undefined;
    return new OpenAIEmbeddings({
      apiKey: plugin.apiKey,
      model: plugin.embeddingModel,
      batchSize: plugin.batchSize,
      ...(configuration ? { configuration } : {}),
    });
  }

  private async getVectorStoreForDomain(
    plugin: LangchainPluginConfig,
    domain: LangchainMemoryDomain,
  ) {
    const embeddings = await this.createEmbeddings(plugin);
    const collectionName = resolveLangchainCollectionName({
      collectionPrefix: plugin.collectionPrefix,
      agentId: this.agentId,
      domain,
    });
    const store = new Chroma(embeddings, {
      url: plugin.chromaUrl,
      collectionName,
    });
    await store.ensureCollection();
    return { store, collectionName };
  }

  private resolveDomainCollections(
    plugin: Pick<LangchainPluginConfig, "collectionPrefix">,
  ): Partial<Record<LangchainMemoryDomain, string>> {
    return Object.fromEntries(
      DOMAIN_ORDER.map((domain) => [
        domain,
        resolveLangchainCollectionName({
          collectionPrefix: plugin.collectionPrefix,
          agentId: this.agentId,
          domain,
        }),
      ]),
    ) as Partial<Record<LangchainMemoryDomain, string>>;
  }

  private readStatusFile(
    plugin: { statusPath: string },
    agent: LangchainAgentConfig,
  ): LangchainStatusFile | null {
    try {
      const parsed = JSON.parse(
        fsSync.readFileSync(plugin.statusPath, "utf-8"),
      ) as LangchainStatusFile;
      if (parsed.agentId !== agent.agentId) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeFailureStatus(params: {
    plugin: LangchainPluginConfig;
    agent: LangchainAgentConfig;
    error: unknown;
  }) {
    const statusFile = this.readStatusFile(params.plugin, params.agent);
    const queueDepth = readPendingQueueDepth(params.plugin.pendingDir);
    const lastError = stringifyError(params.error);
    await writeJsonFile(params.plugin.statusPath, {
      version: 1,
      pluginId: "memory-langchain",
      agentId: params.agent.agentId,
      updatedAt: Date.now(),
      backendReachable: false,
      backendError: lastError,
      lastError,
      lastSyncAt: statusFile?.lastSyncAt,
      queueDepth,
      files: statusFile?.files ?? 0,
      chunks: statusFile?.chunks ?? 0,
      sources: params.agent.sources,
      extraPaths: params.agent.extraPaths,
      roots: params.agent.roots,
      workspaceDir: params.agent.workspaceDir,
      chromaUrl: params.plugin.chromaUrl,
      collectionName:
        statusFile?.collectionName ??
        resolveLangchainCollectionName({
          collectionPrefix: params.plugin.collectionPrefix,
          agentId: params.agent.agentId,
          domain: "user_memory",
        }),
      collections:
        statusFile?.collections ??
        Object.fromEntries(
          DOMAIN_ORDER.map((domain) => [
            domain,
            resolveLangchainCollectionName({
              collectionPrefix: params.plugin.collectionPrefix,
              agentId: params.agent.agentId,
              domain,
            }),
          ]),
        ),
      sourceCounts: statusFile?.sourceCounts ?? [],
    } satisfies LangchainStatusFile);
  }

  status(): MemoryProviderStatus {
    const plugin = resolveLangchainPluginStorageState({
      cfg: this.cfg,
      env: process.env,
    });
    const agent = resolveLangchainAgentConfig({
      cfg: this.cfg,
      agentId: this.agentId,
      workspaceDir: this.workspaceDir,
    });
    const statusFile = this.readStatusFile(plugin, agent);
    const collectionName =
      statusFile?.collectionName ??
      resolveLangchainCollectionName({
        collectionPrefix: plugin.collectionPrefix,
        agentId: agent.agentId,
        domain: "user_memory",
      });
    const queueDepth = readPendingQueueDepth(plugin.pendingDir);
    const failedQueueDepth = readFailedQueueDepth(plugin.queueDir);
    const staleThresholdMs = Math.max(1, plugin.syncIntervalSec) * 2000;
    const staleIndex =
      typeof statusFile?.lastSyncAt === "number"
        ? Date.now() - statusFile.lastSyncAt > staleThresholdMs
        : queueDepth > 0;
    return {
      backend: "plugin",
      provider: "langchain",
      model: plugin.embeddingModel,
      requestedProvider: plugin.embeddingProvider,
      files: statusFile?.files ?? 0,
      chunks: statusFile?.chunks ?? 0,
      dirty: queueDepth > 0,
      workspaceDir: agent.workspaceDir,
      dbPath: plugin.chromaUrl,
      extraPaths: agent.extraPaths,
      sources: agent.sources,
      sourceCounts: statusFile?.sourceCounts ?? [],
      vector: {
        enabled: true,
        available: statusFile?.backendReachable ?? false,
        ...(statusFile?.backendError ? { loadError: statusFile.backendError } : {}),
      },
      custom: {
        pluginId: "memory-langchain",
        chromaUrl: plugin.chromaUrl,
        collectionName,
        collections: statusFile?.collections ?? this.resolveDomainCollections(plugin),
        queueDepth,
        failedQueueDepth,
        lastSyncAt: statusFile?.lastSyncAt,
        lastError: statusFile?.lastError,
        backendError: statusFile?.backendError,
        staleIndex,
        roots: agent.roots,
        syncIntervalSec: plugin.syncIntervalSec,
      },
    };
  }

  async buildStatus(): Promise<MemoryProviderStatus> {
    const { plugin, agent } = await this.resolveRuntime();
    const statusFile = this.readStatusFile(plugin, agent);
    const queueDepth = readPendingQueueDepth(plugin.pendingDir);
    const failedQueueDepth = readFailedQueueDepth(plugin.queueDir);
    const staleThresholdMs = Math.max(1, plugin.syncIntervalSec) * 2000;
    const staleIndex =
      typeof statusFile?.lastSyncAt === "number"
        ? Date.now() - statusFile.lastSyncAt > staleThresholdMs
        : queueDepth > 0;
    return {
      backend: "plugin",
      provider: "langchain",
      model: plugin.embeddingModel,
      requestedProvider: plugin.embeddingProvider,
      files: statusFile?.files ?? 0,
      chunks: statusFile?.chunks ?? 0,
      dirty: queueDepth > 0,
      workspaceDir: agent.workspaceDir,
      dbPath: plugin.chromaUrl,
      extraPaths: agent.extraPaths,
      sources: agent.sources,
      sourceCounts: statusFile?.sourceCounts ?? [],
      vector: {
        enabled: true,
        available: statusFile?.backendReachable ?? false,
      },
      custom: {
        pluginId: "memory-langchain",
        chromaUrl: plugin.chromaUrl,
        collectionName:
          statusFile?.collectionName ??
          resolveLangchainCollectionName({
            collectionPrefix: plugin.collectionPrefix,
            agentId: agent.agentId,
            domain: "user_memory",
          }),
        collections: statusFile?.collections ?? this.resolveDomainCollections(plugin),
        queueDepth,
        failedQueueDepth,
        lastSyncAt: statusFile?.lastSyncAt,
        lastError: statusFile?.lastError,
        backendError: statusFile?.backendError,
        staleIndex,
        roots: agent.roots,
        syncIntervalSec: plugin.syncIntervalSec,
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const { plugin } = await this.resolveRuntime();
      await this.createEmbeddings(plugin);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async probeVectorStatus(params?: { domains?: MemoryDomain[] }): Promise<MemoryVectorProbeStatus> {
    const requestedDomains =
      params?.domains?.filter((domain): domain is LangchainMemoryDomain =>
        DOMAIN_ORDER.includes(domain as LangchainMemoryDomain),
      ) ?? DOMAIN_ORDER;
    const domains = requestedDomains.length > 0 ? requestedDomains : DOMAIN_ORDER;
    try {
      const { plugin } = await this.resolveRuntime();
      const domainResults: NonNullable<MemoryVectorProbeStatus["domains"]> = {};
      let firstError: string | undefined;
      let allAvailable = true;
      for (const domain of domains) {
        const collection = resolveLangchainCollectionName({
          collectionPrefix: plugin.collectionPrefix,
          agentId: this.agentId,
          domain,
        });
        try {
          await this.getVectorStoreForDomain(plugin, domain);
          domainResults[domain] = {
            domain,
            available: true,
            collection,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          allAvailable = false;
          firstError ??= message;
          domainResults[domain] = {
            domain,
            available: false,
            collection,
            error: message,
          };
        }
      }
      return {
        available: allAvailable,
        ...(firstError ? { error: firstError } : {}),
        domains: domainResults,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        error: message,
        domains: Object.fromEntries(
          domains.map((domain) => [
            domain,
            {
              domain,
              available: false,
            },
          ]),
        ) as NonNullable<MemoryVectorProbeStatus["domains"]>,
      };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    const probe = await this.probeVectorStatus({ domains: DOMAIN_ORDER });
    return probe.available;
  }

  async sync(params?: {
    reason?: SyncReason;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const { plugin, agent } = await this.resolveRuntime();
    try {
      ensureDirSync(plugin.documentsDir);
      ensureDirSync(plugin.pendingDir);
      const docs = await collectDocuments({ cfg: this.cfg, plugin, agent });
      const allChunks: ChunkedSourceDocument[] = [];
      const aggregateManifest: IndexManifest = {
        version: 1,
        documents: {},
      };
      params?.progress?.({ completed: 0, total: docs.length, label: "Scanning documents" });
      const collectionNames = Object.fromEntries(
        DOMAIN_ORDER.map((domain) => [
          domain,
          resolveLangchainCollectionName({
            collectionPrefix: plugin.collectionPrefix,
            agentId: agent.agentId,
            domain,
          }),
        ]),
      ) as Partial<Record<LangchainMemoryDomain, string>>;
      const queueDepth = (await fs.readdir(plugin.pendingDir).catch(() => [])).filter((entry) =>
        entry.endsWith(".json"),
      ).length;
      let backendReachable = true;
      const backendErrors: string[] = [];
      let chunks = 0;
      for (const domain of DOMAIN_ORDER) {
        const domainDocs = docs.filter((doc) => doc.domain === domain);
        const domainManifestPath = buildDomainManifestPath(plugin, domain);
        const manifest = await readJsonFile<IndexManifest>(domainManifestPath, EMPTY_MANIFEST);
        const nextManifest: IndexManifest = {
          version: 1,
          documents: {},
        };
        const deleteQueue: string[] = [];
        const domainChunks: ChunkedSourceDocument[] = [];
        const { store } = await this.getVectorStoreForDomain(plugin, domain);
        if (params?.force) {
          const allExistingIds = Object.values(manifest.documents).flatMap((entry) => entry.ids);
          if (allExistingIds.length > 0) {
            await deleteIds(store, allExistingIds);
          }
        }
        for (let index = 0; index < domainDocs.length; index += 1) {
          const doc = domainDocs[index];
          const manifestKey = buildManifestKey(domain, doc.source, doc.path);
          const previous = params?.force ? undefined : manifest.documents[manifestKey];
          if (previous && previous.hash === doc.hash) {
            nextManifest.documents[manifestKey] = previous;
            continue;
          }
          if (previous?.ids.length) {
            deleteQueue.push(...previous.ids);
          }
          const chunked = await chunkDocument(doc, plugin);
          domainChunks.push(...chunked);
          allChunks.push(...chunked);
          nextManifest.documents[manifestKey] = {
            domain,
            source: doc.source,
            path: doc.path,
            hash: doc.hash,
            ids: chunked.map((chunk) => chunk.id),
            chunks: chunked.length,
          };
        }
        if (!params?.force) {
          for (const [manifestKey, entry] of Object.entries(manifest.documents)) {
            if (nextManifest.documents[manifestKey]) {
              continue;
            }
            deleteQueue.push(...entry.ids);
          }
        }
        if (deleteQueue.length > 0) {
          await deleteIds(store, Array.from(new Set(deleteQueue)));
        }
        if (domainChunks.length > 0) {
          await store.addDocuments(
            domainChunks.map(
              (chunk) =>
                new Document({
                  pageContent: chunk.pageContent,
                  metadata: chunk.metadata,
                }),
            ),
            {
              ids: domainChunks.map((chunk) => chunk.id),
            },
          );
        }
        Object.assign(aggregateManifest.documents, nextManifest.documents);
        await writeJsonFile(domainManifestPath, nextManifest);
        try {
          const collection = await store.ensureCollection();
          chunks += await collection.count();
        } catch (error) {
          backendReachable = false;
          backendErrors.push(`${domain}: ${stringifyError(error)}`);
          chunks += domainChunks.length;
        }
      }

      const sourceCounts = countBySource(docs, allChunks);
      params?.progress?.({
        completed: docs.length,
        total: docs.length,
        label: "Indexed documents",
      });
      await writeJsonFile(plugin.manifestPath, aggregateManifest);
      await writeJsonFile(plugin.statusPath, {
        version: 1,
        pluginId: "memory-langchain",
        agentId: agent.agentId,
        updatedAt: Date.now(),
        backendReachable,
        backendError: backendErrors.length > 0 ? backendErrors.join("; ") : undefined,
        lastSyncAt: Date.now(),
        queueDepth,
        files: docs.length,
        chunks,
        sources: agent.sources,
        extraPaths: agent.extraPaths,
        roots: agent.roots,
        workspaceDir: agent.workspaceDir,
        chromaUrl: plugin.chromaUrl,
        collectionName:
          collectionNames.user_memory ??
          resolveLangchainCollectionName({
            collectionPrefix: plugin.collectionPrefix,
            agentId: agent.agentId,
            domain: "user_memory",
          }),
        collections: collectionNames,
        sourceCounts,
        lastError: undefined,
      } satisfies LangchainStatusFile);
    } catch (error) {
      try {
        await this.writeFailureStatus({ plugin, agent, error });
      } catch (statusError) {
        this.logger?.warn?.(
          `memory-langchain failed to update status snapshot: ${stringifyError(statusError)}`,
        );
      }
      throw error;
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      sources?: LangchainMemorySource[];
      scope?: LangchainMemoryScope;
      domain?: LangchainMemoryDomain;
    },
  ): Promise<MemorySearchResult[]> {
    const { plugin, agent } = await this.resolveRuntime();
    const status = await this.buildStatus();
    const requestedSources = (opts?.sources?.length ? opts.sources : agent.sources).filter(
      (source) => agent.sources.includes(source),
    );
    const requestedDomain = opts?.domain ?? inferDomainFromSources(requestedSources);
    const maxResults = Math.max(1, opts?.maxResults ?? agent.maxResults);
    const minScore = Math.max(agent.minScore, opts?.minScore ?? agent.minScore);
    const scope = opts?.scope ?? agent.scope;
    const candidateLimit = Math.max(maxResults * 4, 12);
    const dedupe = new Set<string>();
    const searchDomain = async (domain: LangchainMemoryDomain): Promise<MemorySearchResult[]> => {
      const domainSources = new Set(resolveDomainSources(domain));
      const allowedSources = new Set(
        requestedSources.filter(
          (source) => agent.sources.includes(source) && domainSources.has(source),
        ),
      );
      if (allowedSources.size === 0) {
        return [];
      }
      const mapped: MemorySearchResult[] = [];

      if (domain === "user_memory" && scope !== "session" && allowedSources.has("memory")) {
        await collectExactUserMemoryMatches({
          workspaceDir: agent.workspaceDir,
          query,
          maxResults,
          dedupe,
          mapped,
        });
        if (mapped.length >= maxResults) {
          return mapped;
        }
      }

      let storePromise:
        | Promise<Awaited<ReturnType<typeof this.getVectorStoreForDomain>>>
        | undefined;
      const ensureStore = async () => {
        storePromise ??= this.getVectorStoreForDomain(plugin, domain);
        return (await storePromise).store;
      };

      const collect = async (filter?: Record<string, string>) => {
        const store = await ensureStore();
        const results = await store.similaritySearchWithScore(
          query,
          candidateLimit,
          buildChromaWhereFilter(filter),
        );
        for (const [doc, rawScore] of results) {
          const source = doc.metadata?.source as LangchainMemorySource | undefined;
          if (!source || !allowedSources.has(source)) {
            continue;
          }
          const score = normalizeScore(rawScore);
          if (score < minScore) {
            continue;
          }
          const pathValue = typeof doc.metadata?.path === "string" ? doc.metadata.path : "";
          if (!pathValue) {
            continue;
          }
          const startLine =
            typeof doc.metadata?.startLine === "number" ? Math.trunc(doc.metadata.startLine) : 1;
          const endLine =
            typeof doc.metadata?.endLine === "number"
              ? Math.trunc(doc.metadata.endLine)
              : startLine;
          const dedupeKey = `${pathValue}:${startLine}:${endLine}:${doc.pageContent}`;
          if (dedupe.has(dedupeKey)) {
            continue;
          }
          dedupe.add(dedupeKey);
          mapped.push({
            path: pathValue,
            startLine,
            endLine,
            score,
            snippet: sanitizeSnippet(doc.pageContent),
            source,
            domain,
          });
          if (mapped.length >= maxResults) {
            return;
          }
        }
      };

      if (
        domain === "history" &&
        opts?.sessionKey &&
        (scope === "session" || scope === "prefer_session")
      ) {
        await collect({ source: "sessions", sessionKey: opts.sessionKey });
      }

      if (domain === "user_memory" && mapped.length < maxResults && scope !== "session") {
        try {
          await collect({ source: "memory" });
        } catch (error) {
          if (mapped.length > 0) {
            this.logger?.warn?.(
              `memory-langchain user_memory fallback skipped vector search after exact local match: ${stringifyError(error)}`,
            );
            return mapped;
          }
          throw error;
        }
      }

      if (domain === "docs_kb" && mapped.length < maxResults) {
        await collect();
      }

      if (domain === "history" && mapped.length < maxResults && scope !== "session") {
        await collect();
      }

      return mapped;
    };

    const mapped = requestedDomain
      ? await searchDomain(requestedDomain)
      : (
          await Promise.all(
            DOMAIN_ORDER.filter((domain) =>
              requestedSources.some((source) => resolveDomainSources(domain).includes(source)),
            ).map((domain) => searchDomain(domain)),
          )
        )
          .flat()
          .toSorted(
            (left, right) => right.score - left.score || left.path.localeCompare(right.path),
          )
          .slice(0, maxResults);

    const fallbackWarning = status.custom?.lastError ?? status.custom?.backendError;
    if (mapped.length === 0 && fallbackWarning) {
      this.logger?.warn?.(`memory-langchain search fallback warning: ${String(fallbackWarning)}`);
    }

    return mapped.slice(0, maxResults);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ path: string; text: string }> {
    const { plugin, agent } = await this.resolveRuntime();
    if (
      params.relPath
        .trim()
        .startsWith(`${LANGCHAIN_VIRTUAL_ROOT}/${SESSION_TRANSCRIPT_FALLBACK_DIR}/`)
    ) {
      const absPath = resolveReadPath({
        agent,
        plugin,
        relPath: params.relPath,
      });
      if (!absPath) {
        throw new Error(`Unsupported memory path: ${params.relPath}`);
      }
      const sessionId = path.basename(absPath, path.extname(absPath));
      const content = buildSessionTranscriptFallbackContent(sessionId, absPath);
      if (!content) {
        throw new Error(`Transcript fallback content unavailable: ${params.relPath}`);
      }
      const rows = content.split(/\r?\n/);
      if (params.from === undefined && params.lines === undefined) {
        return {
          path: params.relPath,
          text: sanitizeSnippet(content),
        };
      }
      const startIndex = Math.max(0, (params.from ?? 1) - 1);
      const endIndex =
        params.lines !== undefined
          ? Math.min(rows.length, startIndex + Math.max(1, params.lines))
          : rows.length;
      return {
        path: params.relPath,
        text: sanitizeSnippet(rows.slice(startIndex, endIndex).join("\n")),
      };
    }
    const absPath = resolveReadPath({
      agent,
      plugin,
      relPath: params.relPath,
    });
    if (!absPath) {
      throw new Error(`Unsupported memory path: ${params.relPath}`);
    }
    const text = await fs.readFile(absPath, "utf-8");
    if (params.from === undefined && params.lines === undefined) {
      return {
        path: params.relPath,
        text: sanitizeSnippet(text),
      };
    }
    const rows = text.split(/\r?\n/);
    const startIndex = Math.max(0, (params.from ?? 1) - 1);
    const endIndex =
      params.lines !== undefined
        ? Math.min(rows.length, startIndex + Math.max(1, params.lines))
        : rows.length;
    return {
      path: params.relPath,
      text: sanitizeSnippet(rows.slice(startIndex, endIndex).join("\n")),
    };
  }
}
