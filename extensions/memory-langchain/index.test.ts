import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  enqueueInbound: vi.fn(async () => {}),
  enqueueSessionMessage: vi.fn(async () => {}),
}));

const registerMemoryManagerProviderMock = vi.hoisted(() => vi.fn());
const managerCtorMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/memory-core", () => ({
  registerMemoryManagerProvider: registerMemoryManagerProviderMock,
}));

vi.mock("./src/manager.js", () => ({
  LangchainMemoryManager: managerCtorMock,
}));

vi.mock("./src/runtime.js", () => ({
  createLangchainMemoryRuntime: vi.fn(() => runtimeMocks),
}));

describe("memory-langchain plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers memory tools, manager provider, services, and hooks", async () => {
    const { default: plugin } = await import("./index.js");
    const hooks: Record<string, Function> = {};
    const registerTool = vi.fn();
    const registerService = vi.fn();
    const createMemorySearchTool = vi.fn(() => ({ name: "memory_search" }));
    const createMemoryGetTool = vi.fn(() => ({ name: "memory_get" }));
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      config: {},
      runtime: {
        tools: {
          createMemorySearchTool,
          createMemoryGetTool,
        },
      },
      registerTool,
      registerService,
      on: vi.fn((hookName: string, handler: Function) => {
        hooks[hookName] = handler;
      }),
    };

    plugin.register(api as never);

    expect(registerMemoryManagerProviderMock).toHaveBeenCalledWith(
      "memory-langchain",
      expect.any(Function),
    );
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      names: ["memory_search", "memory_get"],
    });
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "memory-langchain",
        start: expect.any(Function),
        stop: expect.any(Function),
      }),
    );
    expect(api.on).toHaveBeenCalledWith("message_received", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("before_message_write", expect.any(Function));

    const [toolFactory] = registerTool.mock.calls[0] ?? [];
    const tools = toolFactory({
      config: { agents: {} },
      sessionKey: "agent:main:main",
    });
    expect(tools).toEqual([{ name: "memory_search" }, { name: "memory_get" }]);
    expect(createMemorySearchTool).toHaveBeenCalledWith({
      config: { agents: {} },
      agentSessionKey: "agent:main:main",
    });
    expect(createMemoryGetTool).toHaveBeenCalledWith({
      config: { agents: {} },
      agentSessionKey: "agent:main:main",
    });

    await hooks.message_received(
      {
        content: "invoice overdue",
        timestamp: 1710000000000,
        metadata: {
          provider: "slack",
          surface: "telegram",
          body: "full body",
          bodyForAgent: "full body for agent",
          subject: "Invoice overdue",
          attachmentText: "attachment invoice.pdf",
          transcript: "voice transcript",
          messageId: "msg-1",
          threadId: "thread-1",
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
        },
      },
      {
        channelId: "gmail",
        accountId: "inbox",
        conversationId: "conv-1",
        agentId: "research",
        sessionKey: "agent:research:main",
      },
    );
    expect(runtimeMocks.enqueueInbound).toHaveBeenCalledWith({
      cfg: {},
      agentId: "research",
      sessionKey: "agent:research:main",
      channelId: "gmail",
      from: undefined,
      to: undefined,
      provider: "slack",
      surface: "telegram",
      body: "full body",
      bodyForAgent: "full body for agent",
      subject: "Invoice overdue",
      attachmentText: "attachment invoice.pdf",
      transcript: "voice transcript",
      accountId: "inbox",
      conversationId: "conv-1",
      messageId: "msg-1",
      threadId: "thread-1",
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
      isGroup: false,
      content: "invoice overdue",
    });

    await hooks.before_message_write(
      {
        message: { role: "user", content: "remember this" },
      },
      {
        agentId: "research",
        sessionKey: "agent:research:main",
      },
    );
    expect(runtimeMocks.enqueueSessionMessage).toHaveBeenCalledWith({
      cfg: {},
      agentId: "research",
      sessionKey: "agent:research:main",
      role: "user",
      message: { role: "user", content: "remember this" },
    });
  });
});
