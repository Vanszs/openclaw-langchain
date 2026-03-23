import {
  createHistoryGetTool,
  createHistorySearchTool,
  createKnowledgeGetTool,
  createKnowledgeSearchTool,
  createMemoryGetTool,
  createMemorySearchTool,
} from "../../agents/tools/memory-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeTools(): PluginRuntime["tools"] {
  return {
    createHistoryGetTool,
    createHistorySearchTool,
    createKnowledgeGetTool,
    createKnowledgeSearchTool,
    createMemoryGetTool,
    createMemorySearchTool,
    registerMemoryCli,
  };
}
