import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  register(api) {
    api.registerTool(
      (ctx) => {
        const historySearchTool = api.runtime.tools.createHistorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const historyGetTool = api.runtime.tools.createHistoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const knowledgeSearchTool = api.runtime.tools.createKnowledgeSearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const knowledgeGetTool = api.runtime.tools.createKnowledgeGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (
          !historySearchTool ||
          !historyGetTool ||
          !knowledgeSearchTool ||
          !knowledgeGetTool ||
          !memorySearchTool ||
          !memoryGetTool
        ) {
          return null;
        }
        return [
          historySearchTool,
          historyGetTool,
          knowledgeSearchTool,
          knowledgeGetTool,
          memorySearchTool,
          memoryGetTool,
        ];
      },
      {
        names: [
          "history_get",
          "history_search",
          "knowledge_get",
          "knowledge_search",
          "memory_get",
          "memory_search",
        ],
      },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
});
