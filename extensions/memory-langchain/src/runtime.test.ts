import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveLangchainPluginConfigMock = vi.hoisted(() => vi.fn());
const managerSyncMock = vi.hoisted(() => vi.fn(async () => {}));
const managerCtorMock = vi.hoisted(() =>
  vi.fn(
    class MockLangchainMemoryManager {
      sync = managerSyncMock;
    },
  ),
);

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveLangchainPluginConfig: resolveLangchainPluginConfigMock,
  };
});

vi.mock("./manager.js", () => ({
  LangchainMemoryManager: managerCtorMock,
}));

import { createLangchainMemoryRuntime } from "./runtime.js";

describe("LangchainMemoryRuntime", () => {
  let tempDir: string;
  let pluginDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-langchain-runtime-"));
    pluginDir = path.join(tempDir, "plugin");
    cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: path.join(tempDir, "workspace-main") },
          { id: "research", workspace: path.join(tempDir, "workspace-research") },
        ],
      },
    };
    resolveLangchainPluginConfigMock.mockResolvedValue({
      chromaUrl: "http://127.0.0.1:8000",
      collectionPrefix: "openclaw",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      apiKey: "sk-test",
      apiKeyConfigured: true,
      chunkSize: 900,
      chunkOverlap: 150,
      batchSize: 32,
      syncIntervalSec: 0,
      queueDir: path.join(pluginDir, "queue"),
      baseDir: pluginDir,
      documentsDir: path.join(pluginDir, "documents"),
      pendingDir: path.join(pluginDir, "queue", "pending"),
      statusPath: path.join(pluginDir, "status.json"),
      manifestPath: path.join(pluginDir, "manifest.json"),
      logsPath: path.join(pluginDir, "events.jsonl"),
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("queues inbound email messages with normalized metadata", async () => {
    const runtime = createLangchainMemoryRuntime();

    await runtime.enqueueInbound({
      cfg,
      agentId: "research",
      channelId: "gmail",
      provider: "slack",
      surface: "telegram",
      body: "full body",
      bodyForAgent: "full body for agent",
      subject: "Invoice overdue",
      attachmentText: "attachment invoice.pdf",
      transcript: "voice transcript",
      accountId: "default",
      conversationId: "thread-123",
      messageId: "msg-1",
      threadId: "thr-1",
      senderId: "user-1",
      senderName: "Alice",
      senderUsername: "alice",
      senderE164: "+15550001",
      mediaPath: "/tmp/audio.ogg",
      mediaType: "audio/ogg",
      originatingChannel: "whatsapp",
      originatingTo: "+15558889999",
      guildId: "guild-1",
      channelName: "alerts",
      groupId: "group-1",
      timestamp: 1710000000000,
      content: "  invoice attached  ",
    });

    const pendingDir = path.join(pluginDir, "queue", "pending");
    const files = await fs.readdir(pendingDir);
    expect(files).toHaveLength(1);
    const payload = JSON.parse(await fs.readFile(path.join(pendingDir, files[0]!), "utf-8")) as {
      kind: string;
      agentId: string;
      source: string;
      content: string;
      channelId: string;
    };
    expect(payload).toMatchObject({
      kind: "inbound",
      agentId: "research",
      source: "email",
      channelId: "gmail",
      provider: "slack",
      surface: "telegram",
      content: "invoice attached",
      body: "full body",
      bodyForAgent: "full body for agent",
      subject: "Invoice overdue",
      attachmentText: "attachment invoice.pdf",
      transcript: "voice transcript",
      senderE164: "+15550001",
      mediaPath: "/tmp/audio.ogg",
      mediaType: "audio/ogg",
      originatingChannel: "whatsapp",
      originatingTo: "+15558889999",
      guildId: "guild-1",
      channelName: "alerts",
      groupId: "group-1",
    });
  });

  it("derives agent routing and session metadata from sessionKey + session store", async () => {
    const runtime = createLangchainMemoryRuntime();
    const storePath = path.join(tempDir, "sessions.json");
    cfg = {
      ...cfg,
      session: {
        store: storePath,
      },
    };
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:research:telegram:group:-1001:topic:42": {
            sessionId: "agent:research:telegram:group:-1001:topic:42",
            updatedAt: 1710000002000,
            channel: "telegram",
            groupId: "telegram:-1001",
            groupChannel: "#release",
            subject: "Release Squad",
            space: "guild-9",
            chatType: "group",
            origin: {
              provider: "telegram",
              surface: "telegram",
              from: "telegram:user:alice",
              to: "telegram:-1001",
              accountId: "default",
              threadId: 42,
            },
            deliveryContext: {
              channel: "telegram",
              to: "-1001:topic:42",
              accountId: "default",
              threadId: 42,
            },
            lastChannel: "telegram",
            lastTo: "-1001:topic:42",
            lastAccountId: "default",
            lastThreadId: 42,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await runtime.enqueueInbound({
      cfg,
      sessionKey: "agent:research:telegram:group:-1001:topic:42",
      channelId: "telegram",
      content: "status deploy?",
    });
    await runtime.enqueueSessionMessage({
      cfg,
      sessionKey: "agent:research:telegram:group:-1001:topic:42",
      role: "user",
      message: { content: "ingat keputusan release ini" },
    });

    const pendingDir = path.join(pluginDir, "queue", "pending");
    const files = (await fs.readdir(pendingDir)).toSorted();
    const payloads = await Promise.all(
      files.map(async (file) =>
        JSON.parse(await fs.readFile(path.join(pendingDir, file), "utf-8")),
      ),
    );
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "inbound",
          agentId: "research",
          sessionKey: "agent:research:telegram:group:-1001:topic:42",
          accessTag: "session:agent:research:telegram:group:-1001:topic:42",
        }),
        expect.objectContaining({
          kind: "session",
          agentId: "research",
          sessionKey: "agent:research:telegram:group:-1001:topic:42",
          channelId: "telegram",
          accountId: "default",
          conversationId: "-1001:topic:42",
          threadId: "42",
          senderId: "telegram:user:alice",
          groupId: "telegram:-1001",
          groupChannel: "#release",
          groupSpace: "guild-9",
          subject: "Release Squad",
          chatType: "group",
          accessTag: "session:agent:research:telegram:group:-1001:topic:42",
        }),
      ]),
    );
  });

  it("drains the queue into stored docs and syncs all touched agents", async () => {
    const runtime = createLangchainMemoryRuntime();

    await runtime.enqueueInbound({
      cfg,
      channelId: "whatsapp",
      accountId: "default",
      conversationId: "chat-9",
      messageId: "wa-1",
      senderId: "user-9",
      senderName: "Budi",
      timestamp: 1710000001000,
      isGroup: true,
      content: "deploy sekarang",
    });
    await runtime.enqueueSessionMessage({
      cfg,
      agentId: "research",
      sessionKey: "agent:research:main",
      role: "assistant",
      message: { content: "ringkasan release" },
    });

    await runtime.drainAndSync(cfg, path.join(tempDir, "workspace-main"));

    const chatDoc = path.join(pluginDir, "documents", "main", "chat");
    const sessionDoc = path.join(pluginDir, "documents", "research", "sessions");
    expect((await fs.readdir(chatDoc)).some((entry) => entry.endsWith(".md"))).toBe(true);
    expect((await fs.readdir(sessionDoc)).some((entry) => entry.endsWith(".md"))).toBe(true);

    const pendingDir = path.join(pluginDir, "queue", "pending");
    expect(await fs.readdir(pendingDir)).toEqual([]);

    expect(managerCtorMock).toHaveBeenCalledTimes(2);
    expect(managerCtorMock).toHaveBeenCalledWith(
      cfg,
      "main",
      path.join(tempDir, "workspace-main"),
      undefined,
    );
    expect(managerCtorMock).toHaveBeenCalledWith(
      cfg,
      "research",
      path.join(tempDir, "workspace-research"),
      undefined,
    );
    expect(managerSyncMock).toHaveBeenCalledWith({ reason: "service" });
  });
});
