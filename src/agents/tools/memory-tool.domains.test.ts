import { beforeEach, describe, expect, it } from "vitest";
import {
  getMemorySearchMock,
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import {
  createHistoryGetToolOrThrow,
  createHistorySearchToolOrThrow,
  createKnowledgeGetToolOrThrow,
  createKnowledgeSearchToolOrThrow,
  createMemoryGetToolOrThrow,
  createMemorySearchToolOrThrow,
} from "./memory-tool.test-helpers.js";

describe("memory domain tools", () => {
  beforeEach(() => {
    resetMemoryToolMockState({
      statusSources: ["memory"],
      searchImpl: async () => [],
    });
  });

  it("routes memory_search to user_memory only", async () => {
    const tool = createMemorySearchToolOrThrow();

    await tool.execute("memory", { query: "tentang saya" });

    expect(getMemorySearchMock()).toHaveBeenCalledWith("tentang saya", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: undefined,
      domain: "user_memory",
      sources: ["memory"],
    });
  });

  it("routes knowledge_search to memory storage when docs_kb is backed by memory files", async () => {
    const tool = createKnowledgeSearchToolOrThrow();

    await tool.execute("knowledge", { query: "docs openclaw gateway token" });

    expect(getMemorySearchMock()).toHaveBeenCalledWith("docs openclaw gateway token", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: undefined,
      domain: "docs_kb",
      sources: ["memory"],
    });
  });

  it("routes history_search to history sources", async () => {
    resetMemoryToolMockState({
      statusSources: ["sessions"],
      searchImpl: async () => [],
    });
    const tool = createHistorySearchToolOrThrow();

    await tool.execute("history", { query: "kemarin saya bilang apa" });

    expect(getMemorySearchMock()).toHaveBeenCalledWith("kemarin saya bilang apa", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: undefined,
      domain: "history",
      sources: ["sessions"],
    });
  });

  it("rejects history_get outside transcript paths", async () => {
    const tool = createHistoryGetToolOrThrow();

    const result = await tool.execute("history-get", {
      path: "memory/facts/profile/framework.json",
    });

    expect(result.details).toEqual({
      path: "memory/facts/profile/framework.json",
      text: "",
      disabled: true,
      error: "history_get only reads history; rejected (user_memory)",
    });
  });

  it("rejects memory_get outside canonical user_memory paths", async () => {
    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("memory-get", {
      path: "memory/2026-03-23.md",
    });

    expect(result.details).toEqual({
      path: "memory/2026-03-23.md",
      text: "",
      disabled: true,
      error: "memory_get only reads user_memory",
    });
  });

  it("allows knowledge_get to read saved docs_kb notes", async () => {
    setMemoryReadFileImpl(async (params) => ({
      path: params.relPath,
      text: "# Saved note\n\nGateway token docs",
    }));
    const tool = createKnowledgeGetToolOrThrow();

    const result = await tool.execute("knowledge-get", {
      path: "memory/knowledge/openclaw-gateway.v1.md",
    });

    expect(result.details).toEqual({
      path: "memory/knowledge/openclaw-gateway.v1.md",
      text: "# Saved note\n\nGateway token docs",
    });
  });

  it("allows history_get to read built-in session transcript paths", async () => {
    setMemoryReadFileImpl(async (params) => ({
      path: params.relPath,
      text: "User: DuckDB lebih cepat dari SQLite",
    }));
    const tool = createHistoryGetToolOrThrow();

    const result = await tool.execute("history-get", {
      path: "sessions/history-proof.jsonl",
    });

    expect(result.details).toEqual({
      path: "sessions/history-proof.jsonl",
      text: "User: DuckDB lebih cepat dari SQLite",
    });
  });
});
