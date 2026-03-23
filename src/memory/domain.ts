import type { MemoryDomain, MemorySource } from "./types.js";

const USER_MEMORY_SOURCES: MemorySource[] = ["memory"];
const DOCS_KB_SOURCES: MemorySource[] = ["docs", "repo"];
const HISTORY_SOURCES: MemorySource[] = ["chat", "email", "sessions"];

export function resolveDomainSources(domain: MemoryDomain): MemorySource[] {
  if (domain === "user_memory") {
    return [...USER_MEMORY_SOURCES];
  }
  if (domain === "docs_kb") {
    return [...DOCS_KB_SOURCES];
  }
  return [...HISTORY_SOURCES];
}

export function inferDomainFromSources(sources: MemorySource[]): MemoryDomain | undefined {
  const unique = Array.from(new Set(sources));
  if (unique.length === 1 && unique[0] === "memory") {
    return "user_memory";
  }
  if (unique.every((source) => DOCS_KB_SOURCES.includes(source))) {
    return "docs_kb";
  }
  if (unique.every((source) => HISTORY_SOURCES.includes(source))) {
    return "history";
  }
  return undefined;
}

export function isUserMemoryPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, "/");
  return normalized.startsWith("memory/facts/");
}

export function isDocsKbPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, "/");
  return normalized.startsWith("memory/knowledge/");
}

export function isHistoryPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/\\/g, "/");
  return (
    normalized.startsWith("langchain/chat/") ||
    normalized.startsWith("langchain/email/") ||
    normalized.startsWith("langchain/sessions/")
  );
}

export function inferDomainFromPath(relPath: string): MemoryDomain | undefined {
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
