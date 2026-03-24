import { loadAgentIdentityFromWorkspace } from "../agents/identity-file.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { ReplyPayload } from "./types.js";

const IDENTITY_QUERY_RE =
  /^(?:siapa\s+(?:anda|kamu|dirimu)|who\s+are\s+you|what\s+is\s+your\s+name)\b/i;
const ORCHESTRA_QUERY_RE =
  /(?:(?:\b(?:model|models?)\b.*\b(?:orkestra|orchestra)\b)|(?:\b(?:orkestra|orchestra)\b.*\b(?:model|models?)\b)).*(?:\b(?:apa\s+saja|what|which|punya|memiliki|have)\b)?/i;

export type DeterministicSelfReplyContext = {
  directReply: ReplyPayload;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatModelLabel(modelRef: string | undefined): string | undefined {
  const normalized = modelRef?.trim();
  if (!normalized) {
    return undefined;
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function buildIdentityReply(workspaceDir: string): ReplyPayload {
  const identity = loadAgentIdentityFromWorkspace(workspaceDir);
  const name = identity?.name?.trim();
  return {
    text: name ? `Saya ${name}.` : "Saya asisten Anda.",
  };
}

function buildOrchestraReply(cfg: OpenClawConfig): ReplyPayload {
  const defaults = cfg.agents?.defaults;
  const textPrimary = formatModelLabel(resolveAgentModelPrimaryValue(defaults?.model));
  const textFallbacks = resolveAgentModelFallbackValues(defaults?.model)
    .map((entry) => formatModelLabel(entry))
    .filter((entry): entry is string => Boolean(entry));
  const imagePrimary = formatModelLabel(resolveAgentModelPrimaryValue(defaults?.imageModel));
  const imageFallbacks = resolveAgentModelFallbackValues(defaults?.imageModel)
    .map((entry) => formatModelLabel(entry))
    .filter((entry): entry is string => Boolean(entry));

  const parts: string[] = [];
  if (textPrimary) {
    parts.push(
      textFallbacks.length > 0
        ? `Untuk teks saya memakai ${textPrimary}, dengan fallback ${textFallbacks.join(", ")}.`
        : `Untuk teks saya memakai ${textPrimary}.`,
    );
  }
  if (imagePrimary) {
    parts.push(
      imageFallbacks.length > 0
        ? `Untuk OCR dan gambar saya memakai ${imagePrimary}, dengan fallback ${imageFallbacks.join(", ")}.`
        : `Untuk OCR dan gambar saya memakai ${imagePrimary}.`,
    );
  }
  return {
    text: parts.join(" ") || "Saya belum memiliki konfigurasi model orchestra yang aktif saat ini.",
  };
}

export async function buildDeterministicSelfReplyContext(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  query: string;
}): Promise<DeterministicSelfReplyContext | undefined> {
  const query = normalizeWhitespace(params.query);
  if (!query) {
    return undefined;
  }
  if (IDENTITY_QUERY_RE.test(query)) {
    return {
      directReply: buildIdentityReply(params.workspaceDir),
    };
  }
  if (ORCHESTRA_QUERY_RE.test(query)) {
    return {
      directReply: buildOrchestraReply(params.cfg),
    };
  }
  return undefined;
}
