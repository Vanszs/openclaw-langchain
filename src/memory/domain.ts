import type { MemoryDomain, MemorySource } from "./types.js";

const USER_MEMORY_SOURCES: MemorySource[] = ["memory"];
const DOCS_KB_SOURCES: MemorySource[] = ["docs", "repo"];
const HISTORY_SOURCES: MemorySource[] = ["chat", "email", "sessions"];
const DOCS_KB_STORAGE_SOURCES: MemorySource[] = ["docs", "repo", "memory"];

export function resolveDomainSources(domain: MemoryDomain): MemorySource[] {
  if (domain === "user_memory") {
    return [...USER_MEMORY_SOURCES];
  }
  if (domain === "docs_kb") {
    return [...DOCS_KB_SOURCES];
  }
  return [...HISTORY_SOURCES];
}

export function resolveDomainStorageSources(domain: MemoryDomain): MemorySource[] {
  if (domain === "docs_kb") {
    return [...DOCS_KB_STORAGE_SOURCES];
  }
  return resolveDomainSources(domain);
}

export function resolveSearchSourcesForDomain(params: {
  domain?: MemoryDomain;
  requestedSources?: MemorySource[];
  availableSources?: Iterable<MemorySource>;
}): MemorySource[] {
  const availableSet = params.availableSources
    ? new Set(Array.from(params.availableSources))
    : undefined;
  const requested =
    params.requestedSources?.length && params.requestedSources.length > 0
      ? params.requestedSources
      : params.domain
        ? resolveDomainSources(params.domain)
        : availableSet
          ? Array.from(availableSet)
          : [];
  if (!availableSet) {
    return [...requested];
  }
  const direct = requested.filter((source) => availableSet.has(source));
  if (direct.length > 0 || !params.domain) {
    return direct;
  }
  return resolveDomainStorageSources(params.domain).filter((source) => availableSet.has(source));
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
    normalized.startsWith("sessions/") ||
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

export function matchesResultDomain(params: {
  domain: MemoryDomain;
  path: string;
  source: MemorySource;
}): boolean {
  const inferred = inferDomainFromPath(params.path);
  if (inferred) {
    return inferred === params.domain;
  }
  if (params.domain === "user_memory") {
    return isUserMemoryPath(params.path);
  }
  if (params.domain === "docs_kb") {
    return params.source === "docs" || params.source === "repo";
  }
  return params.source === "chat" || params.source === "email" || params.source === "sessions";
}
