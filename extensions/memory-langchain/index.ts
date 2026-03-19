import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { registerMemoryManagerProvider } from "openclaw/plugin-sdk/memory-core";
import { LANGCHAIN_MEMORY_PLUGIN_ID } from "./src/config.js";
import { LangchainMemoryManager } from "./src/manager.js";
import { createLangchainMemoryRuntime } from "./src/runtime.js";

export default definePluginEntry({
  id: LANGCHAIN_MEMORY_PLUGIN_ID,
  name: "Memory (LangChain)",
  description: "LangChain.js + Chroma memory backend",
  kind: "memory",
  register(api) {
    const runtime = createLangchainMemoryRuntime(api.logger);
    const logQueueError = (scope: string, error: unknown) => {
      api.logger.warn(`memory-langchain: ${scope} enqueue failed: ${String(error)}`);
    };

    registerMemoryManagerProvider(LANGCHAIN_MEMORY_PLUGIN_ID, async (ctx) => {
      return new LangchainMemoryManager(ctx.cfg, ctx.agentId, ctx.workspaceDir, api.logger);
    });

    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    api.registerService({
      id: LANGCHAIN_MEMORY_PLUGIN_ID,
      start: async (ctx) => {
        await runtime.start({
          cfg: ctx.config,
          workspaceDir: ctx.workspaceDir ?? process.cwd(),
        });
      },
      stop: async () => {
        await runtime.stop();
      },
    });

    api.on("message_received", (event, ctx) => {
      void runtime
        .enqueueInbound({
          cfg: api.config,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          channelId: ctx.channelId,
          from: event.from,
          to: typeof event.metadata?.to === "string" ? event.metadata.to : undefined,
          provider:
            typeof event.metadata?.provider === "string" ? event.metadata.provider : undefined,
          surface: typeof event.metadata?.surface === "string" ? event.metadata.surface : undefined,
          body: typeof event.metadata?.body === "string" ? event.metadata.body : undefined,
          bodyForAgent:
            typeof event.metadata?.bodyForAgent === "string"
              ? event.metadata.bodyForAgent
              : undefined,
          subject: typeof event.metadata?.subject === "string" ? event.metadata.subject : undefined,
          attachmentText:
            typeof event.metadata?.attachmentText === "string"
              ? event.metadata.attachmentText
              : undefined,
          transcript:
            typeof event.metadata?.transcript === "string" ? event.metadata.transcript : undefined,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          messageId:
            typeof event.metadata?.messageId === "string" ? event.metadata.messageId : undefined,
          threadId:
            typeof event.metadata?.threadId === "string" ||
            typeof event.metadata?.threadId === "number"
              ? event.metadata.threadId
              : undefined,
          senderId:
            typeof event.metadata?.senderId === "string" ? event.metadata.senderId : undefined,
          senderName:
            typeof event.metadata?.senderName === "string" ? event.metadata.senderName : undefined,
          senderUsername:
            typeof event.metadata?.senderUsername === "string"
              ? event.metadata.senderUsername
              : undefined,
          senderE164:
            typeof event.metadata?.senderE164 === "string" ? event.metadata.senderE164 : undefined,
          mediaPath:
            typeof event.metadata?.mediaPath === "string" ? event.metadata.mediaPath : undefined,
          mediaType:
            typeof event.metadata?.mediaType === "string" ? event.metadata.mediaType : undefined,
          originatingChannel:
            typeof event.metadata?.originatingChannel === "string"
              ? event.metadata.originatingChannel
              : undefined,
          originatingTo:
            typeof event.metadata?.originatingTo === "string"
              ? event.metadata.originatingTo
              : undefined,
          guildId: typeof event.metadata?.guildId === "string" ? event.metadata.guildId : undefined,
          channelName:
            typeof event.metadata?.channelName === "string"
              ? event.metadata.channelName
              : undefined,
          groupId: typeof event.metadata?.groupId === "string" ? event.metadata.groupId : undefined,
          timestamp: event.timestamp,
          isGroup: event.metadata?.isGroup === true,
          content: event.content,
        })
        .catch((error) => {
          logQueueError("message_received", error);
        });
    });

    api.on("before_message_write", (event, ctx) => {
      void runtime
        .enqueueSessionMessage({
          cfg: api.config,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          role: typeof event.message?.role === "string" ? event.message.role : undefined,
          message: event.message,
        })
        .catch((error) => {
          logQueueError("before_message_write", error);
        });
    });
  },
});
