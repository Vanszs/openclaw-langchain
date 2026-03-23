import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import {
  inferDomainFromPath,
  isHistoryPath,
  isUserMemoryPath,
  resolveDomainSources,
} from "../../memory/domain.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemoryDomain, MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

async function getMemoryManagerContext(params: { cfg: OpenClawConfig; agentId: string }): Promise<
  | {
      manager: NonNullable<Awaited<ReturnType<typeof getMemorySearchManager>>["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return manager ? { manager } : { error };
}

function createMemoryTool(params: {
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
  };
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: params.execute(ctx),
  };
}

type MemoryDomainToolConfig = {
  label: string;
  name: string;
  domain: MemoryDomain;
  searchDescription: string;
  getDescription: string;
  allowReadPath: (relPath: string) => boolean;
};

const USER_MEMORY_TOOL: MemoryDomainToolConfig = {
  label: "Memory",
  name: "memory",
  domain: "user_memory",
  searchDescription:
    "Mandatory recall step for facts about the user: search canonical user_memory facts that were explicitly remembered about the user. Use this before answering what is stored about the user in memory/RAG/Chroma/the index. If disabled=true, user-memory retrieval is unavailable and that must be surfaced instead of guessing.",
  getDescription:
    "Safe snippet read for canonical user_memory facts after memory_search. Use this to inspect the exact stored fact lines while keeping context small.",
  allowReadPath: (relPath) => isUserMemoryPath(relPath),
};

const KNOWLEDGE_TOOL: MemoryDomainToolConfig = {
  label: "Knowledge",
  name: "knowledge",
  domain: "docs_kb",
  searchDescription:
    "Search saved knowledge documents, imported docs, saved research results, and indexed repo/docs references. Use this for documentation, manuals, references, repo knowledge, or saved external knowledge. If disabled=true, knowledge retrieval is unavailable and that must be surfaced instead of guessing.",
  getDescription:
    "Safe snippet read for docs_kb or repo/docs knowledge results after knowledge_search. Use this to inspect the exact retrieved document lines while keeping context small.",
  allowReadPath: (relPath) => !isUserMemoryPath(relPath) && !isHistoryPath(relPath),
};

const HISTORY_TOOL: MemoryDomainToolConfig = {
  label: "History",
  name: "history",
  domain: "history",
  searchDescription:
    "Search immutable prior conversation and session history. Use this for questions about what was said earlier, previous turns, prior chats, or transcript history. If disabled=true, history retrieval is unavailable and that must be surfaced instead of guessing.",
  getDescription:
    "Safe snippet read for transcript/history results after history_search. Use this to inspect the exact prior-message lines while keeping context small.",
  allowReadPath: (relPath) => isHistoryPath(relPath),
};

function buildSearchToolName(config: MemoryDomainToolConfig): string {
  return `${config.name}_search`;
}

function buildGetToolName(config: MemoryDomainToolConfig): string {
  return `${config.name}_get`;
}

function buildUnavailableResult(params: {
  error: string | undefined;
  toolName: string;
  subject: string;
}) {
  const reason =
    (params.error ?? `${params.subject} unavailable`).trim() || `${params.subject} unavailable`;
  const subjectLabel =
    params.subject.length > 0
      ? `${params.subject.charAt(0).toUpperCase()}${params.subject.slice(1)}`
      : params.subject;
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const isVectorBackendError =
    /chroma|getorcreatecollection|vector backend|vector store|connectionerror|failed to connect|expected 'where'/i.test(
      reason,
    );
  const warning = isQuotaError
    ? `${subjectLabel} is unavailable because the embedding provider quota is exhausted.`
    : isVectorBackendError
      ? `${subjectLabel} is unavailable because the vector backend is unreachable.`
      : `${subjectLabel} is unavailable due to an embedding/provider error.`;
  const action = isQuotaError
    ? `Top up or switch embedding provider, then retry ${params.toolName}.`
    : isVectorBackendError
      ? `Start or fix the Chroma/vector backend, then retry ${params.toolName}.`
      : `Check embedding provider configuration and retry ${params.toolName}.`;
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}

function decorateResultsForDomain(
  results: MemorySearchResult[],
  includeCitations: boolean,
): MemorySearchResult[] {
  return decorateCitations(results, includeCitations);
}

function createDomainSearchTool(
  config: MemoryDomainToolConfig,
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
  },
): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: `${config.label} Search`,
    name: buildSearchToolName(config),
    description: config.searchDescription,
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult(
            buildUnavailableResult({
              error: memory.error,
              toolName: buildSearchToolName(config),
              subject: `${config.label.toLowerCase()} search`,
            }),
          );
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          const rawResults = await memory.manager.search(query, {
            maxResults,
            minScore,
            sessionKey: options.agentSessionKey,
            domain: config.domain,
            sources: resolveDomainSources(config.domain),
          });
          const status = memory.manager.status();
          const decorated = decorateResultsForDomain(rawResults, includeCitations);
          const resolved = resolveMemoryBackendConfig({ cfg, agentId });
          const results =
            status.backend === "qmd"
              ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
              : decorated;
          const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
          return jsonResult({
            results,
            provider: status.provider,
            model: status.model,
            fallback: status.fallback,
            citations: citationsMode,
            mode: searchMode,
            domain: config.domain,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult(
            buildUnavailableResult({
              error: message,
              toolName: buildSearchToolName(config),
              subject: `${config.label.toLowerCase()} search`,
            }),
          );
        }
      },
  });
}

function createDomainGetTool(
  config: MemoryDomainToolConfig,
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
  },
): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: `${config.label} Get`,
    name: buildGetToolName(config),
    description: config.getDescription,
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        if (!config.allowReadPath(relPath)) {
          const inferredDomain = inferDomainFromPath(relPath);
          const suffix = inferredDomain ? `(${inferredDomain})` : "";
          return jsonResult({
            path: relPath,
            text: "",
            disabled: true,
            error: `${buildGetToolName(config)} only reads ${config.domain}${suffix ? `; rejected ${suffix}` : ""}`,
          });
        }
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        try {
          const result = await memory.manager.readFile({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
          });
          return jsonResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ path: relPath, text: "", disabled: true, error: message });
        }
      },
  });
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createDomainSearchTool(USER_MEMORY_TOOL, options);
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createDomainGetTool(USER_MEMORY_TOOL, options);
}

export function createKnowledgeSearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createDomainSearchTool(KNOWLEDGE_TOOL, options);
}

export function createKnowledgeGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createDomainGetTool(KNOWLEDGE_TOOL, options);
}

export function createHistorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createDomainSearchTool(HISTORY_TOOL, options);
}

export function createHistoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createDomainGetTool(HISTORY_TOOL, options);
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
