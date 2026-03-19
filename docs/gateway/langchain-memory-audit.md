---
title: "LangChain Memory Audit"
summary: "Audit status for the OpenClaw + LangChain.js memory plugin plan"
status: active
---

# LangChain Memory Audit

Audit date: `2026-03-19`

This page compares the current implementation against the original
`OpenClaw + LangChain.js` plan.

## Current verdict

- `memory-langchain` exists as a dedicated memory-slot plugin under
  `extensions/memory-langchain`.
- OpenClaw still owns gateway, sessions, tool routing, model fallback, and
  subagent orchestration.
- The main foundation is in place, but the implementation is still **partial**
  against the original plan.

## Status by plan item

### Summary

- `[x]` LangChain.js is being used as a memory/RAG backend rather than as the
  main agent orchestrator.
- `[x]` The new plugin lives at `extensions/memory-langchain` and is selected by
  `plugins.slots.memory = "memory-langchain"`.
- `[~]` The five intended improvements are only partially complete.
  Retrieval compatibility and operator wiring are mostly there, while canonical
  ingestion coverage and test depth still need work.

### Public interfaces and config

- `[x]` Plugin id `memory-langchain` exists with `kind: "memory"`.
  Files:
  `extensions/memory-langchain/index.ts`
  `extensions/memory-langchain/openclaw.plugin.json`

- `[x]` `plugins.entries.memory-langchain.config` has the planned keys:
  `chromaUrl`, `collectionPrefix`, `embeddingProvider`, `embeddingModel`,
  `apiKeySecretRef`, `chunkSize`, `chunkOverlap`, `batchSize`,
  `syncIntervalSec`, `queueDir`.
  File:
  `extensions/memory-langchain/openclaw.plugin.json`

- `[x]` `agents.*.memorySearch` is backend-agnostic enough for the LangChain
  plugin flow.
  It now supports source enablement, `roots`, `extraPaths`, and query scope.
  Files:
  `src/config/types.tools.ts`
  `src/config/zod-schema.agent-runtime.ts`

- `[x]` Existing memory affordances are preserved.
  The plugin uses the existing `memory_search`, `memory_get`, and
  `openclaw memory` path by plugging into the shared memory manager contract.
  Files:
  `extensions/memory-langchain/index.ts`
  `src/memory/plugin-manager-registry.ts`
  `src/memory/search-manager.ts`
  `src/cli/memory-cli.ts`

- `[x]` `openclaw memory status`, `sync`, and `reindex` are available when the
  LangChain backend is active.
  File:
  `src/cli/memory-cli.ts`

- `[x]` Status and doctor understand custom memory plugins and show plugin
  signals such as backend reachability, queue depth, and sync freshness.
  Files:
  `src/commands/status.scan.shared.ts`
  `src/commands/status.scan.ts`
  `src/commands/status.command.ts`
  `src/commands/doctor-memory-search.ts`

### Plugin and adapter layer

- `[x]` `extensions/memory-langchain` is an in-process plugin.
  Files:
  `extensions/memory-langchain/index.ts`
  `extensions/memory-langchain/src/manager.ts`
  `extensions/memory-langchain/src/runtime.ts`

- `[x]` A plugin-local memory-manager adapter exists and satisfies the shared
  memory manager contract.
  Files:
  `src/memory/plugin-manager-registry.ts`
  `src/plugin-sdk/memory-core.ts`

- `[x]` Existing built-in and QMD memory backends remain intact.
  File:
  `src/memory/search-manager.ts`

### Source ingestion improvements

- `[~]` `repo/docs` ingestion exists and uses language-aware splitting.
  This part is mostly implemented through file classification and LangChain
  text splitters.
  File:
  `extensions/memory-langchain/src/manager.ts`

- `[~]` `chat/email` ingestion is only partially aligned with the plan.
  Current behavior:
  - listens to `message_received`
  - uses the routed `agentId` when `message_received` is emitted with a
    resolved `sessionKey`
  - stores text content
  - stores canonical `body`, `bodyForAgent`, `transcript`, and basic media
    metadata when those values are already present on the inbound hook
  - records channel, provider/surface, conversation, thread, sender, group, and
    originating-route metadata

  Gaps:
  - inbound events still fall back to the default agent when no routed
    `sessionKey` is available on the hook path
  - subject/body/attachment-aware email extraction is not implemented
  - access tags are not being filled from canonical policy data

  Files:
  `extensions/memory-langchain/index.ts`
  `extensions/memory-langchain/src/runtime.ts`

- `[~]` `sessions` ingestion exists, but not exactly as specified.
  Current behavior:
  - listens to `before_message_write`
  - stores message text plus `sessionKey` and `role`
  - falls back to agent transcript `.jsonl` files when canonical session docs
    are missing

  Gaps:
  - session metadata is still thinner than the plan's ideal target

  Files:
  `extensions/memory-langchain/index.ts`
  `extensions/memory-langchain/src/runtime.ts`
  `extensions/memory-langchain/src/manager.ts`

- `[x]` Idempotent indexing exists.
  Stable ids and manifest-based sync prevent duplicate chunk creation across
  repeated sync/reindex runs.
  Files:
  `extensions/memory-langchain/src/config.ts`
  `extensions/memory-langchain/src/manager.ts`

### Retrieval behavior

- `[x]` Retrieval uses LangChain + Chroma and maps results back into the shared
  OpenClaw memory result shape.
  Files:
  `extensions/memory-langchain/src/manager.ts`
  `src/memory/types.ts`

- `[x]` Source-aware recall exists.
  The manager supports source filtering and session-vs-global scope.
  Files:
  `extensions/memory-langchain/src/manager.ts`
  `extensions/memory-langchain/src/config.ts`

- `[x]` Retrieved snippets are sanitized before being injected back into the
  agent flow.
  File:
  `extensions/memory-langchain/src/manager.ts`

- `[x]` LangChain has not been turned into a second top-level orchestrator.
  OpenClaw still owns orchestration and subagent control.

### Operator and setup surfaces

- `[x]` `configure --section memory` exists and can switch between built-in
  memory and `memory-langchain`.
  Files:
  `src/commands/configure.shared.ts`
  `src/commands/configure.wizard.ts`

- `[x]` `openclaw onboard` now supports memory / RAG setup in both interactive
  and non-interactive local flows.
  Files:
  `src/wizard/setup.ts`
  `src/commands/memory-config-prompt.ts`
  `src/commands/memory-config-shared.ts`
  `src/commands/onboard-non-interactive/local/memory-config.ts`

- `[x]` Status and doctor treat custom memory plugins as first-class enough for
  day-to-day operation.

- `[x]` Docs now make the boundary explicit:
  OpenClaw orchestrates, `memory-langchain` indexes and retrieves.
  Files:
  `docs/cli/configure.md`
  `docs/cli/agents.md`
  `docs/concepts/multi-agent.md`
  `docs/gateway/configuration-reference.md`
  `docs/gateway/configuration-examples.md`

### Test plan coverage

- `[x]` Slot compatibility is covered at the registry integration level.
  File:
  `src/memory/search-manager.test.ts`

- `[~]` Dedicated plugin tests now exist for the new LangChain backend.
  Covered areas:
  - plugin registration and hook wiring
  - runtime queueing and drain-to-doc flow
  - sync and idempotent re-sync behavior
  - retrieval filtering, session preference, and snippet sanitization

  Files:
  `extensions/memory-langchain/index.test.ts`
  `extensions/memory-langchain/src/runtime.test.ts`
  `extensions/memory-langchain/src/manager.test.ts`

- `[ ]` Remaining plugin test gaps:
  - richer email ingestion such as subject/body/attachment extraction
  - fallback behavior when no routed `sessionKey` is available on inbound hooks
  - degraded Chroma/backend failure scenarios inside the plugin
  - broader metadata assertions for access policy and group routing

- `[~]` CLI, status, and doctor behavior have focused coverage, but the
  LangChain plugin still needs deeper failure-path coverage.
  Files:
  `src/cli/memory-cli.test.ts`
  `src/commands/doctor-memory-search.test.ts`
  `src/commands/status.scan.test.ts`
  `src/commands/configure.wizard.test.ts`

## Orchestrator configuration findings

The OpenClaw orchestration side for `3` specialist models is already supported.

Important config paths:

- `agents.defaults.model`
- `agents.defaults.models`
- `agents.defaults.subagents.maxSpawnDepth`
- `agents.list[].model`
- `agents.list[].subagents.allowAgents`
- `agents.list[].subagents.model`
- `bindings[]`

This means the intended split is viable today:

- OpenClaw orchestrator agent: front-door chat and routing
- research agent: higher-quality reasoning model
- coding agent: code-specialized model
- LangChain memory plugin: chunking, embeddings, Chroma, retrieval

## Recommended next steps

1. Add dedicated tests for `extensions/memory-langchain` covering ingest,
   retrieval, and failure handling.
   Status: partially done. The next layer should focus on failure paths and
   richer canonical ingest cases.
2. Fix inbound ingest so events are indexed under the actual routed agent, not
   always the default agent.
3. Enrich canonical chat/email ingestion with `isGroup`, attachment text,
   subject/body handling, and `accessTag`.
4. Add a transcript-export fallback ingest path for cases where canonical events
   are unavailable.
5. Keep interactive, configure, and non-interactive onboarding aligned on the
   same shared memory config helper as the feature grows.
