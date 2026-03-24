import { loadAgentIdentityFromWorkspace } from "../agents/identity-file.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { logVerbose } from "../globals.js";
import type { ReplyPayload } from "./types.js";

const IDENTITY_QUERY_RE =
  /(?:\bsiapa\s+(?:anda|kamu|dirimu)\b|\bwho\s+are\s+you\b|\bwhat\s+is\s+your\s+name\b)/i;
const GMAIL_CAPABILITY_RE =
  /\b(gmail|google\s*mail)\b.*\b(terhubung|pakai|memakai|use|using|support|tersedia|available|aktif|configured|setup|integrasi)\b|\b(terhubung|pakai|memakai|use|using|support|tersedia|available|aktif|configured|setup|integrasi)\b.*\b(gmail|google\s*mail)\b/i;
const CALENDAR_CAPABILITY_RE =
  /\b(calendar|kalender|google\s*calendar|gcal)\b.*\b(terhubung|pakai|memakai|use|using|support|tersedia|available|aktif|configured|setup|integrasi|buat)\b|\b(terhubung|pakai|memakai|use|using|support|tersedia|available|aktif|configured|setup|integrasi|buat)\b.*\b(calendar|kalender|google\s*calendar|gcal)\b/i;
const WEBHOOK_CAPABILITY_RE =
  /\bwebhook\b.*\b(terhubung|pakai|memakai|use|using|support|tersedia|available|aktif|configured|setup|integrasi)\b|\b(terhubung|pakai|memakai|use|using|support|tersedia|available|aktif|configured|setup|integrasi)\b.*\bwebhook\b/i;
const INTEGRATION_SUBJECT_RE =
  /\b(anda|kamu|dirimu|you|your|assistant|runtime|instance|environment|server)\b|\b(?:di|in)\s+(?:runtime|lingkungan|environment|instance)\b|\blingkungan\s+ini\b/i;
const SELF_CUE_RE = /\b(anda|kamu|dirimu|you|your|assistant|ai)\b/i;
const ORCHESTRA_CUE_RE = /\b(orkestra|orchestra|orchestration|orchestrator|orkestrasi|fallback)\b/i;
const ORCHESTRA_RUNTIME_RE = /\b(model|ai|llm|runtime|ocr|gambar|image|text|teks)\b/i;
const ORCHESTRA_DETAIL_RE = /\b(model|models?|ai|llm|ocr|gambar|image|text|teks|fallback)\b/i;
const ORCHESTRA_STATUS_RE =
  /\b(pakai|memakai|use|using|terhubung|configured|aktif|enabled|running|jalan|status)\b/i;
const ORCHESTRA_INVENTORY_RE =
  /\b(which|what|mana|daftar|list|inventory|punya|memiliki|have|apa\s+saja)\b/i;
const MUSIC_ORCHESTRA_NEGATIVE_RE =
  /\b(musik|music|lagu|song|konduktor|conductor|simfoni|symphony|panggung|instrument)\b/i;

export type DeterministicSelfReplyContext = {
  directReply: ReplyPayload;
};

type RuntimeOrchestraState = {
  textPrimary?: string;
  textFallbacks?: string[];
  imagePrimary?: string;
  imageFallbacks?: string[];
};

type SelfIntent = "identity" | "orchestra_status" | "orchestra_inventory" | "integration";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSelfQuery(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/[?!.,;:()[\]{}"']/g, " ")
      .replace(/\borchesctra\b/g, "orchestra")
      .replace(/\borchesta\b/g, "orchestra")
      .replace(/\borkestraa\b/g, "orkestra")
      .replace(/\borkestrasi\b/g, "orchestra")
      .replace(/\bmemakai\b/g, "pakai")
      .replace(/\busing\b/g, "use")
      .replace(/\bterhubung\s+dengan\b/g, "terhubung")
      .replace(/\bgoogle\s*mail\b/g, "gmail")
      .replace(/\bgoogle\s*calendar\b/g, "calendar"),
  );
}

function formatModelLabel(modelRef: string | undefined): string | undefined {
  const normalized = modelRef?.trim();
  if (!normalized) {
    return undefined;
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function hasOrchestraContext(query: string): boolean {
  if (!ORCHESTRA_CUE_RE.test(query)) {
    return false;
  }
  if (MUSIC_ORCHESTRA_NEGATIVE_RE.test(query) && !ORCHESTRA_RUNTIME_RE.test(query)) {
    return false;
  }
  return (
    SELF_CUE_RE.test(query) || ORCHESTRA_RUNTIME_RE.test(query) || ORCHESTRA_STATUS_RE.test(query)
  );
}

function hasIntegrationContext(query: string): boolean {
  return INTEGRATION_SUBJECT_RE.test(query);
}

function detectSelfIntent(query: string): SelfIntent | undefined {
  if (!query) {
    return undefined;
  }
  if (IDENTITY_QUERY_RE.test(query)) {
    return "identity";
  }
  const asksIntegrationCapability =
    GMAIL_CAPABILITY_RE.test(query) ||
    CALENDAR_CAPABILITY_RE.test(query) ||
    WEBHOOK_CAPABILITY_RE.test(query);
  if (hasIntegrationContext(query) && asksIntegrationCapability) {
    return "integration";
  }
  if (!hasOrchestraContext(query)) {
    return undefined;
  }
  const asksInventory =
    ORCHESTRA_INVENTORY_RE.test(query) ||
    ORCHESTRA_DETAIL_RE.test(query) ||
    /\b(?:orkestra|orchestra|fallback)\b.*\bapa\b/i.test(query) ||
    /\bapa\b.*\b(?:model|models?|fallback)\b/i.test(query);
  const asksStatus = ORCHESTRA_STATUS_RE.test(query);
  if (asksStatus && !asksInventory) {
    return "orchestra_status";
  }
  if (asksInventory || ORCHESTRA_RUNTIME_RE.test(query)) {
    return "orchestra_inventory";
  }
  return "orchestra_status";
}

function buildIdentityReply(workspaceDir: string): ReplyPayload {
  const identity = loadAgentIdentityFromWorkspace(workspaceDir);
  const name = identity?.name?.trim();
  return {
    text: name ? `Saya ${name}.` : "Saya asisten Anda.",
  };
}

function buildOrchestraSummary(cfg: OpenClawConfig, runtime?: RuntimeOrchestraState): string {
  const defaults = cfg.agents?.defaults;
  const textPrimary = formatModelLabel(
    runtime?.textPrimary ?? resolveAgentModelPrimaryValue(defaults?.model),
  );
  const textFallbacks = (runtime?.textFallbacks ?? resolveAgentModelFallbackValues(defaults?.model))
    .map((entry) => formatModelLabel(entry))
    .filter((entry): entry is string => Boolean(entry));
  const imagePrimary = formatModelLabel(
    runtime?.imagePrimary ?? resolveAgentModelPrimaryValue(defaults?.imageModel),
  );
  const imageFallbacks = (
    runtime?.imageFallbacks ?? resolveAgentModelFallbackValues(defaults?.imageModel)
  )
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
  return parts.join(" ") || "Saya belum memiliki konfigurasi model orchestra yang aktif saat ini.";
}

function buildOrchestraReply(
  cfg: OpenClawConfig,
  intent: SelfIntent,
  runtime?: RuntimeOrchestraState,
): ReplyPayload {
  const summary = buildOrchestraSummary(cfg, runtime);
  return {
    text:
      intent === "orchestra_status" && !summary.startsWith("Saya belum")
        ? `Ya. ${summary}`
        : summary,
  };
}

function detectCalendarIntegrationEnabled(cfg: OpenClawConfig): boolean {
  const pluginKeys = Object.keys(cfg.plugins?.entries ?? {}).map((entry) => entry.toLowerCase());
  const mcpConfig = cfg.mcp as Record<string, unknown> | undefined;
  const mcpKeys =
    mcpConfig && typeof mcpConfig === "object"
      ? Object.keys(mcpConfig).map((entry) => entry.toLowerCase())
      : [];
  return [...pluginKeys, ...mcpKeys].some(
    (entry) => entry.includes("calendar") || entry.includes("gcal"),
  );
}

function buildIntegrationCapabilityReply(cfg: OpenClawConfig, query: string): ReplyPayload {
  const wantsGmail = /\bgmail\b/i.test(query);
  const wantsCalendar = /\bcalendar\b|\bkalender\b|\bgcal\b/i.test(query);
  const wantsWebhook = /\bwebhook\b/i.test(query);
  const gmailConfigured = Boolean(cfg.hooks?.gmail?.account?.trim());
  const hooksEnabled = cfg.hooks?.enabled !== false;
  const calendarEnabled = detectCalendarIntegrationEnabled(cfg);

  const parts: string[] = [];
  if (wantsGmail) {
    parts.push(
      gmailConfigured
        ? `Gmail didukung dan saat ini sudah dikonfigurasi untuk ${cfg.hooks?.gmail?.account?.trim()}.`
        : hooksEnabled
          ? "Gmail didukung, tetapi belum dikonfigurasi di runtime ini."
          : "Gmail sedang nonaktif di runtime ini.",
    );
  }
  if (wantsCalendar) {
    parts.push(
      calendarEnabled
        ? "Google Calendar terdeteksi sebagai integrasi aktif di runtime ini."
        : "Google Calendar tidak terdeteksi sebagai integrasi aktif di runtime ini.",
    );
  }
  if (wantsWebhook) {
    parts.push(
      hooksEnabled ? "Webhook tersedia di runtime ini." : "Webhook sedang nonaktif di runtime ini.",
    );
  }
  return {
    text: parts.join(" ") || "Saya tidak mendeteksi integrasi aktif untuk permintaan itu saat ini.",
  };
}

export async function buildDeterministicSelfReplyContext(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  query: string;
  runtime?: RuntimeOrchestraState;
}): Promise<DeterministicSelfReplyContext | undefined> {
  const query = normalizeSelfQuery(params.query);
  const intent = detectSelfIntent(query);
  if (!intent) {
    return undefined;
  }
  if (intent === "identity") {
    logVerbose("self-facts: matched identity intent");
    return {
      directReply: buildIdentityReply(params.workspaceDir),
    };
  }
  if (intent === "integration") {
    logVerbose("self-facts: matched integration capability intent");
    return {
      directReply: buildIntegrationCapabilityReply(params.cfg, query),
    };
  }
  logVerbose(`self-facts: matched ${intent} intent`);
  return {
    directReply: buildOrchestraReply(params.cfg, intent, params.runtime),
  };
}
