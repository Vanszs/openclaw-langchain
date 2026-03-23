import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createHistoryGetTool,
  createHistorySearchTool,
  createKnowledgeGetTool,
  createKnowledgeSearchTool,
  createMemoryGetTool,
  createMemorySearchTool,
} from "./memory-tool.js";

export function asOpenClawConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config as OpenClawConfig;
}

export function createDefaultMemoryToolConfig(): OpenClawConfig {
  return asOpenClawConfig({ agents: { list: [{ id: "main", default: true }] } });
}

export function createMemorySearchToolOrThrow(params?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  const tool = createMemorySearchTool({
    config: params?.config ?? createDefaultMemoryToolConfig(),
    ...(params?.agentSessionKey ? { agentSessionKey: params.agentSessionKey } : {}),
  });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createMemoryGetToolOrThrow(
  config: OpenClawConfig = createDefaultMemoryToolConfig(),
) {
  const tool = createMemoryGetTool({ config });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createKnowledgeSearchToolOrThrow(params?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  const tool = createKnowledgeSearchTool({
    config: params?.config ?? createDefaultMemoryToolConfig(),
    ...(params?.agentSessionKey ? { agentSessionKey: params.agentSessionKey } : {}),
  });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createKnowledgeGetToolOrThrow(
  config: OpenClawConfig = createDefaultMemoryToolConfig(),
) {
  const tool = createKnowledgeGetTool({ config });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createHistorySearchToolOrThrow(params?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  const tool = createHistorySearchTool({
    config: params?.config ?? createDefaultMemoryToolConfig(),
    ...(params?.agentSessionKey ? { agentSessionKey: params.agentSessionKey } : {}),
  });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createHistoryGetToolOrThrow(
  config: OpenClawConfig = createDefaultMemoryToolConfig(),
) {
  const tool = createHistoryGetTool({ config });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createAutoCitationsMemorySearchTool(agentSessionKey: string) {
  return createMemorySearchToolOrThrow({
    config: asOpenClawConfig({
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    }),
    agentSessionKey,
  });
}

export function expectUnavailableMemorySearchDetails(
  details: unknown,
  params: {
    error: string;
    warning: string;
    action: string;
  },
) {
  expect(details).toEqual({
    results: [],
    disabled: true,
    unavailable: true,
    error: params.error,
    warning: params.warning,
    action: params.action,
  });
}
