import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUserMemoryFactPath, upsertUserMemoryFact } from "../memory/user-memory-store.js";

vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn().mockReturnValue("main"),
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: vi.fn().mockReturnValue({ enabled: true }),
}));

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(),
}));

vi.mock("../memory/backend-config.js", () => ({
  resolveMemoryBackendConfig: vi.fn().mockReturnValue({ backend: "langchain" }),
}));

vi.mock("../memory/qmd-scope.js", () => ({
  isQmdScopeAllowed: vi.fn().mockReturnValue(true),
}));

import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";
import { isQmdScopeAllowed } from "../memory/qmd-scope.js";
import {
  buildDeterministicMemoryRecallContext,
  shouldInjectDeterministicMemoryRecall,
} from "./memory-recall.js";

const tempDirs: string[] = [];
const ownerCfg = {
  commands: {
    ownerAllowFrom: ["telegram:123", "whatsapp:+15551234567"],
  },
};

async function createWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-recall-"));
  tempDirs.push(dir);
  return dir;
}

describe("memory recall deterministic routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveMemorySearchConfig).mockReturnValue({
      enabled: true,
      query: { scope: "prefer_session" },
    } as never);
    vi.mocked(resolveMemoryBackendConfig).mockReturnValue({ backend: "langchain" } as never);
    vi.mocked(isQmdScopeAllowed).mockReturnValue(true);
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("matches explicit memory/RAG recall questions", () => {
    expect(shouldInjectDeterministicMemoryRecall("cek chroma db")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("ada apa saja di rag")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("is memory working")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("anda bisa akses rag?")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("can you access chroma db?")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("who am i?")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("apa yang kamu tahu tentang aku?")).toBe(true);
    expect(
      shouldInjectDeterministicMemoryRecall(
        "informasi apa yg anda punya di rag chroma db tentang saya?",
      ),
    ).toBe(true);
    expect(
      shouldInjectDeterministicMemoryRecall(
        "Gunakan tool memory_search untuk mencari informasi tentang saya.",
      ),
    ).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("cari docs OpenClaw tentang gateway token")).toBe(
      true,
    );
    expect(shouldInjectDeterministicMemoryRecall("kemarin saya bilang apa tentang DuckDB?")).toBe(
      true,
    );
  });

  it("does not match memory save requests or generic system phrasing", () => {
    expect(
      shouldInjectDeterministicMemoryRecall("simpan informasi yang menurut anda penting di rag"),
    ).toBe(false);
    expect(shouldInjectDeterministicMemoryRecall("why is memory usage high?")).toBe(false);
    expect(shouldInjectDeterministicMemoryRecall("how do I create an index in sqlite?")).toBe(
      false,
    );
    expect(shouldInjectDeterministicMemoryRecall("show the previous error")).toBe(false);
  });

  it("answers `siapa saya?` from canonical active owner facts", async () => {
    const workspaceDir = await createWorkspace();
    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "profile",
      key: "name.full",
      value: "Bevan Satria",
      provenance: { source: "test" },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "siapa saya?",
      workspaceDir,
    });

    expect(result?.directReply?.text).toBe(
      "Nama yang saya simpan untuk owner profile ini adalah Bevan Satria.",
    );
    expect(result?.note).toContain("owner-profile");
  });

  it("rejects owner-profile reads outside owner direct chat", async () => {
    const workspaceDir = await createWorkspace();
    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "profile",
      key: "name.full",
      value: "Bevan Satria",
      provenance: { source: "test" },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:group:ops",
        Provider: "telegram",
        ChatType: "group",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "siapa saya?",
      workspaceDir,
    });

    expect(result?.directReply?.text).toBe(
      "Owner profile hanya bisa dibaca oleh owner dari chat direct.",
    );
    expect(result?.note).toContain("Retrieval status: access-denied");
  });

  it.each([
    {
      name: "direct non-owner",
      ctx: {
        SessionKey: "agent:main:telegram:direct:999",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "999",
      },
    },
    {
      name: "group non-owner",
      ctx: {
        SessionKey: "agent:main:telegram:group:ops",
        Provider: "telegram",
        ChatType: "group",
        SenderId: "999",
      },
    },
  ])("rejects owner-profile reads for $name", async ({ ctx }) => {
    const workspaceDir = await createWorkspace();
    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "profile",
      key: "name.full",
      value: "Bevan Satria",
      provenance: { source: "test" },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx,
      cfg: ownerCfg,
      query: "siapa saya?",
      workspaceDir,
    });

    expect(result?.directReply?.text).toBe(
      "Owner profile hanya bisa dibaca oleh owner dari chat direct.",
    );
    expect(result?.note).toContain("Retrieval status: access-denied");
  });

  it("rejects internal operator-admin direct chats that do not match an explicit owner", async () => {
    const workspaceDir = await createWorkspace();
    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "profile",
      key: "name.full",
      value: "Bevan Satria",
      provenance: { source: "test" },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "telegram",
        ChatType: "direct",
        SenderId: "cli",
        GatewayClientScopes: ["operator.admin"],
      },
      cfg: ownerCfg,
      query: "siapa saya?",
      workspaceDir,
    });

    expect(result?.directReply?.text).toBe(
      "Owner profile hanya bisa dibaca oleh owner dari chat direct.",
    );
    expect(result?.note).toContain("Retrieval status: access-denied");
  });

  it("rejects generic user_memory recall when the caller is not an explicit owner", async () => {
    const workspaceDir = await createWorkspace();

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "telegram",
        ChatType: "direct",
        SenderId: "cli",
        GatewayClientScopes: ["operator.admin"],
      },
      cfg: ownerCfg,
      query: "memory_search typed check",
      workspaceDir,
    });

    expect(result?.directReply?.text).toBe(
      "Owner profile hanya bisa dibaca oleh owner dari chat direct.",
    );
    expect(result?.note).toContain("Retrieval status: access-denied");
  });

  it("reads canonical owner facts across owner channels without filtering by sender provenance", async () => {
    const workspaceDir = await createWorkspace();
    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "profile",
      key: "name.full",
      value: "Bevan Satria",
      provenance: {
        source: "telegram",
        provider: "telegram",
        senderId: "123",
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:whatsapp:direct:+15551234567",
        Provider: "whatsapp",
        ChatType: "direct",
        SenderId: "+15551234567",
        SenderUsername: "different-owner-hint",
      },
      cfg: ownerCfg,
      query: "siapa saya?",
      workspaceDir,
    });

    expect(result?.directReply?.text).toBe(
      "Nama yang saya simpan untuk owner profile ini adalah Bevan Satria.",
    );
    expect(result?.note).toContain("Retrieval status: owner-profile (1 fact)");
  });

  it("prefers the newest canonical owner fact when duplicate active records already exist", async () => {
    const workspaceDir = await createWorkspace();
    const olderPath = resolveUserMemoryFactPath({
      workspaceDir,
      namespace: "profile",
      id: "profile-name.full-older",
    });
    const newerPath = resolveUserMemoryFactPath({
      workspaceDir,
      namespace: "profile",
      id: "profile-name.full-newer",
    });
    await fs.mkdir(path.dirname(olderPath), { recursive: true });
    await fs.writeFile(
      olderPath,
      `${JSON.stringify(
        {
          id: "profile-name.full-older",
          namespace: "profile",
          key: "name.full",
          value: "Older Owner",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          provenance: { source: "telegram", provider: "telegram", senderId: "123" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      newerPath,
      `${JSON.stringify(
        {
          id: "profile-name.full-newer",
          namespace: "profile",
          key: "name.full",
          value: "Newest Owner",
          status: "active",
          createdAt: 2,
          updatedAt: 2,
          provenance: { source: "webchat", provider: "webchat", senderId: "cli" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:whatsapp:direct:+15551234567",
        Provider: "whatsapp",
        ChatType: "direct",
        SenderId: "+15551234567",
      },
      cfg: ownerCfg,
      query: "siapa saya?",
      workspaceDir,
    });

    expect(result?.directReply?.text).toBe(
      "Nama yang saya simpan untuk owner profile ini adalah Newest Owner.",
    );
    expect(result?.note).toContain("Retrieval status: owner-profile (1 fact)");
  });

  it("returns retrieved user_memory snippets when search succeeds", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([
          {
            path: "memory/facts/preferences/framework-favorite.json",
            startLine: 1,
            endLine: 2,
            score: 0.4012,
            snippet: "- Alergi udang\n- Database favorit: DuckDB",
            source: "memory",
            domain: "user_memory",
          },
        ]),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["memory", "chat"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
        SenderUsername: "belugaa",
      },
      cfg: ownerCfg,
      query: "informasi apa yg anda punya di rag chroma db tentang saya?",
    });

    expect(result?.domain).toBe("user_memory");
    expect(result?.note).toContain("Retrieved context");
    expect(result?.note).toContain("Domain: user_memory");
    expect(result?.note).toContain("Retrieval status: ok (1 result)");
    expect(result?.note).toContain("Provider: langchain");
    expect(result?.note).toContain("Database favorit: DuckDB");
    expect(result?.systemPromptHint).toContain("Deterministic user-memory recall already ran");
  });

  it("routes docs/reference questions to docs_kb retrieval", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        path: "docs/gateway/configuration.md",
        startLine: 10,
        endLine: 12,
        score: 0.51,
        snippet: "Gateway token: shared auth for the Gateway + Control UI.",
        source: "docs",
        domain: "docs_kb",
      },
    ]);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["docs", "repo"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "cari docs OpenClaw tentang gateway token",
    });

    expect(result?.domain).toBe("docs_kb");
    expect(search).toHaveBeenCalledWith(
      "cari docs OpenClaw tentang gateway token",
      expect.objectContaining({
        domain: "docs_kb",
        sources: ["docs", "repo"],
      }),
    );
    expect(result?.note).toContain("Domain: docs_kb");
    expect(result?.note).toContain("Gateway token: shared auth");
    expect(result?.directReply?.text).toContain("Dari docs KB yang saya temukan:");
  });

  it("allows docs_kb recall through canonical memory storage when backend exposes only memory", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        path: "memory/knowledge/openclaw-gateway.v1.md",
        startLine: 4,
        endLine: 6,
        score: 0.58,
        snippet: "Gateway token amber-ocean lives in the saved knowledge note.",
        source: "memory",
        domain: "docs_kb",
      },
    ]);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "builtin",
          provider: "none",
          sources: ["memory"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "cari docs OpenClaw tentang gateway token amber-ocean",
    });

    expect(result?.domain).toBe("docs_kb");
    expect(search).toHaveBeenCalledWith(
      "cari docs OpenClaw tentang gateway token amber-ocean",
      expect.objectContaining({
        domain: "docs_kb",
        sources: ["memory"],
      }),
    );
    expect(result?.note).toContain("Retrieval status: ok (1 result)");
    expect(result?.note).toContain("memory/knowledge/openclaw-gateway.v1.md");
    expect(result?.directReply?.text).toContain("amber-ocean lives in the saved knowledge note");
  });

  it("reports scope denial instead of pretending there were no matches", async () => {
    vi.mocked(resolveMemoryBackendConfig).mockReturnValue({
      backend: "qmd",
      qmd: { scope: "direct" },
    } as never);
    vi.mocked(isQmdScopeAllowed).mockReturnValue(false);

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:group:ops",
      },
      cfg: { agents: { defaults: {} } },
      query: "cari docs OpenClaw tentang gateway token",
    });

    expect(result?.note).toContain("Retrieval status: scope-denied");
    expect(result?.note).toContain("Backend error: scope denied for this chat");
    expect(result?.directReply?.text).toBe(
      "Memory domain ini tidak tersedia dari scope chat saat ini.",
    );
  });

  it("reports scope denial when session scope hides results that still exist globally", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          path: "langchain/sessions/history-proof.md",
          startLine: 2,
          endLine: 3,
          score: 0.74,
          snippet: "Scope proof token",
          source: "sessions",
          domain: "history",
        },
      ]);
    vi.mocked(resolveMemorySearchConfig).mockReturnValue({
      enabled: true,
      query: { scope: "session" },
    } as never);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["sessions"],
        }),
      },
    } as never);

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:webchat:direct:history-b",
      },
      cfg: { agents: { defaults: {} } },
      query: "apa yang tadi saya bilang soal Scope proof token?",
    });

    expect(search).toHaveBeenNthCalledWith(
      1,
      "apa yang saya bilang soal Scope proof token?",
      expect.objectContaining({
        sessionKey: "agent:main:webchat:direct:history-b",
        domain: "history",
        scope: "session",
      }),
    );
    expect(search).toHaveBeenNthCalledWith(
      2,
      "apa yang saya bilang soal Scope proof token?",
      expect.objectContaining({
        domain: "history",
        scope: "global",
      }),
    );
    expect(result?.note).toContain("Retrieval status: scope-denied");
    expect(result?.directReply?.text).toBe(
      "Memory domain ini tidak tersedia dari scope chat saat ini.",
    );
  });

  it("reports scope denial for session-scoped langchain recall when broader matches exist", async () => {
    vi.mocked(resolveMemorySearchConfig).mockReturnValue({
      enabled: true,
      query: { scope: "session" },
    } as never);
    const search = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          path: "langchain/sessions/other-session.md",
          startLine: 5,
          endLine: 6,
          score: 0.44,
          snippet: "## user\nSaya suka DuckDB",
          source: "sessions",
          domain: "history",
        },
      ]);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["sessions"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "kemarin saya bilang apa tentang DuckDB?",
    });

    expect(search).toHaveBeenNthCalledWith(
      1,
      "saya bilang apa tentang DuckDB?",
      expect.objectContaining({
        scope: "session",
        domain: "history",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
    expect(search).toHaveBeenNthCalledWith(
      2,
      "saya bilang apa tentang DuckDB?",
      expect.objectContaining({
        scope: "global",
        maxResults: 1,
        domain: "history",
      }),
    );
    expect(result?.note).toContain("Retrieval status: scope-denied");
    expect(result?.note).toContain("Backend error: scope denied for this chat");
    expect(result?.directReply?.text).toBe(
      "Memory domain ini tidak tersedia dari scope chat saat ini.",
    );
  });

  it("routes transcript questions to history retrieval", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        path: "langchain/sessions/test.md",
        startLine: 3,
        endLine: 4,
        score: 0.44,
        snippet: "## user\nSaya suka DuckDB",
        source: "sessions",
        domain: "history",
      },
    ]);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["sessions"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "kemarin saya bilang apa tentang DuckDB?",
    });

    expect(result?.domain).toBe("history");
    expect(search).toHaveBeenCalledWith(
      "saya bilang apa tentang DuckDB?",
      expect.objectContaining({
        domain: "history",
        sources: ["sessions"],
      }),
    );
    expect(result?.note).toContain("Domain: history");
    expect(result?.directReply?.text).toContain("Di history yang saya temukan:");
    expect(result?.directReply?.text).toContain("Saya suka DuckDB");
  });

  it("returns live backend status for chroma health questions", async () => {
    const status = {
      backend: "plugin",
      provider: "langchain",
      model: "text-embedding-3-small",
      dbPath: "http://127.0.0.1:8889",
      vector: { enabled: true, available: false },
      custom: {
        collectionName: "openclaw-main-user-memory",
        backendError: "stale cached error",
      },
    };
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue(status),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn().mockResolvedValue(true),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "cek chroma db",
    });

    expect(result?.note).toContain("Deterministic route: memory-backend-status");
    expect(result?.note).toContain("Retrieval status: backend-ready");
    expect(result?.note).toContain("Vector probe: ok");
    expect(result?.note).toContain("Store: configured");
    expect(result?.note).not.toContain("stale cached error");
    expect(result?.directReply).toEqual({
      text: "Ya, saya bisa mengakses RAG. Backend Chroma siap dan domain yang dapat di-query saat ini: user memory, docs KB, history.",
    });
    expect(result?.systemPromptHint).toContain(
      "Deterministic memory backend status probing already ran",
    );
    expect(result?.systemPromptHint).toContain("do not expose raw store URLs");
  });

  it("returns deterministic inventory guidance for generic RAG inventory questions", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          dbPath: "http://127.0.0.1:8889",
          vector: { enabled: true, available: true },
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn().mockResolvedValue(true),
        probeVectorStatus: vi.fn().mockResolvedValue({
          available: true,
          domains: {
            user_memory: {
              domain: "user_memory",
              available: true,
              collection: "openclaw-main-user-memory",
            },
            docs_kb: {
              domain: "docs_kb",
              available: true,
              collection: "openclaw-main-docs-kb",
            },
            history: {
              domain: "history",
              available: true,
              collection: "openclaw-main-history",
            },
          },
        }),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "ada apa saja di rag",
    });

    expect(result?.note).toContain("Deterministic route: rag-inventory");
    expect(result?.note).toContain("Retrieval status: backend-ready");
    expect(result?.directReply?.text).toContain("RAG saya dibagi menjadi tiga domain");
    expect(result?.directReply?.text).toContain("Backend Chroma siap.");
  });

  it("reports per-domain partial backend health when one collection probe fails", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          dbPath: "http://127.0.0.1:8889",
          vector: { enabled: true, available: false },
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn().mockResolvedValue(false),
        probeVectorStatus: vi.fn().mockResolvedValue({
          available: false,
          error: "history collection unavailable",
          domains: {
            user_memory: {
              domain: "user_memory",
              available: true,
              collection: "openclaw-main-user-memory",
            },
            docs_kb: {
              domain: "docs_kb",
              available: true,
              collection: "openclaw-main-docs-kb",
            },
            history: {
              domain: "history",
              available: false,
              collection: "openclaw-main-history",
              error: "history collection unavailable",
            },
          },
        }),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "status chroma db",
    });

    expect(result?.note).toContain("Retrieval status: backend-partial");
    expect(result?.note).toContain("Vector probe: partial");
    expect(result?.note).toContain("- history: failed | collection=openclaw-main-history");
    expect(result?.note).toContain("Backend error: history collection unavailable");
    expect(result?.directReply?.text).toContain("Saya bisa mengakses sebagian RAG.");
    expect(result?.directReply?.text).toContain("Domain yang aktif: user memory, docs KB.");
    expect(result?.directReply?.text).toContain("Domain yang bermasalah: history.");
  });

  it("reports backend-unavailable when the live vector probe fails", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          dbPath: "http://127.0.0.1:8889",
          vector: { enabled: true, available: false },
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "status chroma db",
    });

    expect(result?.note).toContain("Retrieval status: backend-unavailable");
    expect(result?.note).toContain("Vector probe: failed");
    expect(result?.note).toContain("Backend error: connect ECONNREFUSED");
    expect(result?.directReply).toEqual({
      text: "Saat ini saya tidak bisa mengakses RAG. Koneksi ke backend RAG gagal.",
    });
  });

  it("returns unavailable context when backend is unavailable", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: null,
      error: "Chroma connection refused",
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "apa isi rag chroma saya?",
    });

    expect(result?.note).toContain("Retrieval status: unavailable");
    expect(result?.note).toContain("Backend error: Chroma connection refused");
    expect(result?.directReply?.text).toBe(
      "Saat ini saya belum bisa membaca memory karena backend RAG sedang tidak siap.",
    );
  });

  it("maps docs_kb recall to memory storage when the backend only exposes memory files", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        path: "memory/knowledge/openclaw-gateway.v1.md",
        startLine: 1,
        endLine: 2,
        score: 0.55,
        snippet: "Gateway token docs live in the knowledge store.",
        source: "memory",
        domain: "docs_kb",
      },
    ]);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["memory"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "cari docs OpenClaw tentang gateway token",
    });

    expect(result?.note).toContain("Domain: docs_kb");
    expect(result?.note).toContain("Retrieval status: ok (1 result)");
    expect(result?.note).toContain("Gateway token docs live in the knowledge store.");
    expect(search).toHaveBeenCalledWith(
      "cari docs OpenClaw tentang gateway token",
      expect.objectContaining({
        domain: "docs_kb",
        sources: ["memory"],
      }),
    );
  });

  it("reports domain-unavailable when the backend sources do not expose history", async () => {
    const search = vi.fn();
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["memory"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "kemarin saya bilang apa tentang DuckDB?",
    });

    expect(result?.note).toContain("Domain: history");
    expect(result?.note).toContain("Retrieval status: domain-unavailable");
    expect(result?.note).toContain("configured backend does not expose history");
    expect(search).not.toHaveBeenCalled();
  });

  it("returns no-match context when recall finds nothing", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([]),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["memory"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "what do you have in memory about me?",
    });

    expect(result?.note).toContain("Retrieval status: no matches");
    expect(result?.note).toContain("Results: none");
  });
});
