// Shared config/runtime boundary for plugins that need config loading,
// config writes, or session-store helpers without importing src internals.

export * from "../config/config.js";
export * from "../config/markdown-tables.js";
export * from "../config/group-policy.js";
export * from "../config/runtime-group-policy.js";
export * from "../config/commands.js";
export * from "../config/discord-preview-streaming.js";
export * from "../config/io.js";
export * from "../config/telegram-custom-commands.js";
export * from "../config/talk.js";
export * from "../config/agent-limits.js";
export * from "../cron/store.js";
export * from "../sessions/model-overrides.js";
export { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
export type * from "../config/types.slack.js";
export {
  loadSessionStore,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveSessionTranscriptsDirForAgent,
  resolveSessionKey,
  resolveStorePath,
  updateLastRoute,
  updateSessionStore,
  type SessionResetMode,
  type SessionScope,
} from "../config/sessions.js";
export { readSessionMessages } from "../gateway/session-utils.fs.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export { resolveSessionStoreEntry } from "../config/sessions/store.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export {
  resolveConfiguredSecretInputString,
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "../gateway/resolve-configured-secret-input-string.js";
