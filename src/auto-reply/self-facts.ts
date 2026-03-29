import { loadAgentIdentityFromWorkspace } from "../agents/identity-file.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { logVerbose } from "../globals.js";
import {
  tokenizeSemanticText,
  hasSemanticConcept,
  findSemanticConceptIndex,
  type SemanticToken,
} from "./semantic-concepts.js";
import type { ReplyPayload } from "./types.js";

const SELF_SEMANTIC_LEXICON = {
  self_target: [
    "anda",
    "kamu",
    "dirimu",
    "you",
    "your",
    "assistant",
    "ai",
    "anda sendiri",
    "kamu sendiri",
  ],
  runtime_context: ["runtime", "instance", "environment", "server", "lingkungan"],
  ask_identity: ["siapa", "who", "who are you"],
  ask_what: ["apa", "what", "mana"],
  ask_now: ["sekarang", "now"],
  facet_name: ["name", "nama"],
  facet_role: [
    "tugas",
    "task",
    "job",
    "role",
    "peran",
    "fungsi",
    "duty",
    "kerja",
    "apa tugas",
    "apa peran",
    "kerja apa",
    "fungsi utama",
    "what do you do",
  ],
  facet_gmail: ["gmail"],
  facet_calendar: ["calendar", "kalender", "gcal"],
  facet_webhook: ["webhook"],
  facet_orchestra: ["orkestra", "orchestra", "orchestration", "orchestrator"],
  facet_model: [
    "model",
    "models",
    "ai",
    "llm",
    "ocr",
    "gambar",
    "image",
    "text",
    "teks",
    "fallback",
  ],
  qualifier_inventory: [
    "which",
    "what",
    "mana",
    "daftar",
    "list",
    "inventory",
    "punya",
    "memiliki",
    "have",
  ],
  qualifier_status: [
    "pakai",
    "use",
    "terhubung",
    "terhubung dengan",
    "support",
    "tersedia",
    "available",
    "aktif",
    "configured",
    "setup",
    "integrasi",
    "buat",
    "enabled",
    "running",
    "jalan",
    "status",
    "dipakai",
    "aktif nggak",
    "lagi available",
  ],
  negative_music: [
    "musik",
    "music",
    "lagu",
    "song",
    "konduktor",
    "conductor",
    "simfoni",
    "symphony",
    "panggung",
    "instrument",
  ],
} satisfies Record<string, readonly string[]>;

export type DeterministicSelfReplyContext = {
  directReply: ReplyPayload;
};

type RuntimeOrchestraState = {
  textPrimary?: string;
  textFallbacks?: string[];
  imagePrimary?: string;
  imageFallbacks?: string[];
};

type SelfIntent = "identity" | "role" | "orchestra_status" | "orchestra_inventory" | "integration";

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

function tokenizeSelfSemantics(query: string): SemanticToken[] {
  return tokenizeSemanticText(query, SELF_SEMANTIC_LEXICON);
}

function hasIdentityIntent(tokens: SemanticToken[]): boolean {
  return (
    (hasSemanticConcept(tokens, "ask_identity") && hasSemanticConcept(tokens, "self_target")) ||
    (hasSemanticConcept(tokens, "ask_what") &&
      hasSemanticConcept(tokens, "facet_name") &&
      hasSemanticConcept(tokens, "self_target"))
  );
}

function hasRoleIntent(tokens: SemanticToken[]): boolean {
  if (!hasSemanticConcept(tokens, "facet_role")) {
    return false;
  }
  return hasSelfContext(tokens) || hasSemanticConcept(tokens, "ask_what");
}

function hasSelfContext(tokens: SemanticToken[]): boolean {
  return hasSemanticConcept(tokens, "self_target") || hasSemanticConcept(tokens, "runtime_context");
}

function hasRuntimeModelQuestion(tokens: SemanticToken[]): boolean {
  return (
    hasSemanticConcept(tokens, "facet_model") &&
    (hasSemanticConcept(tokens, "qualifier_inventory") ||
      hasSemanticConcept(tokens, "qualifier_status") ||
      hasSemanticConcept(tokens, "ask_now") ||
      hasSemanticConcept(tokens, "ask_what"))
  );
}

function asksOrchestraInventory(tokens: SemanticToken[]): boolean {
  const orchestraIndex = findSemanticConceptIndex(tokens, "facet_orchestra");
  if (orchestraIndex < 0) {
    return false;
  }
  const trailingWhatIndex = findSemanticConceptIndex(tokens, "ask_what", {
    fromEnd: true,
  });
  return trailingWhatIndex > orchestraIndex;
}

function hasOrchestraContext(tokens: SemanticToken[]): boolean {
  if (
    hasRuntimeModelQuestion(tokens) &&
    (hasSelfContext(tokens) || hasSemanticConcept(tokens, "ask_now"))
  ) {
    return true;
  }
  if (!hasSemanticConcept(tokens, "facet_orchestra")) {
    return false;
  }
  if (hasSemanticConcept(tokens, "negative_music") && !hasSemanticConcept(tokens, "facet_model")) {
    return false;
  }
  return (
    hasSelfContext(tokens) ||
    hasSemanticConcept(tokens, "facet_model") ||
    hasSemanticConcept(tokens, "qualifier_status")
  );
}

function hasIntegrationContext(tokens: SemanticToken[]): boolean {
  return hasSelfContext(tokens);
}

function hasBareRuntimeIntegrationQuestion(tokens: SemanticToken[]): boolean {
  const wantsIntegration =
    hasSemanticConcept(tokens, "facet_gmail") ||
    hasSemanticConcept(tokens, "facet_calendar") ||
    hasSemanticConcept(tokens, "facet_webhook");
  if (!wantsIntegration || !hasSemanticConcept(tokens, "qualifier_status")) {
    return false;
  }

  const allowedConcepts = new Set([
    "facet_gmail",
    "facet_calendar",
    "facet_webhook",
    "runtime_context",
    "ask_now",
    "qualifier_status",
    "ask_what",
  ]);
  const extraTokens = tokens.filter(
    (token) =>
      token.concepts.length === 0 ||
      token.concepts.every((concept) => !allowedConcepts.has(concept)),
  );
  return extraTokens.length === 0;
}

function detectSelfIntent(query: string): SelfIntent | undefined {
  if (!query) {
    return undefined;
  }
  const tokens = tokenizeSelfSemantics(query);
  if (hasIdentityIntent(tokens)) {
    return "identity";
  }
  if (hasRoleIntent(tokens)) {
    return "role";
  }
  const asksIntegrationCapability =
    hasSemanticConcept(tokens, "qualifier_status") &&
    (hasSemanticConcept(tokens, "facet_gmail") ||
      hasSemanticConcept(tokens, "facet_calendar") ||
      hasSemanticConcept(tokens, "facet_webhook"));
  if (
    (hasIntegrationContext(tokens) && asksIntegrationCapability) ||
    hasBareRuntimeIntegrationQuestion(tokens)
  ) {
    return "integration";
  }
  if (!hasOrchestraContext(tokens)) {
    return undefined;
  }
  const asksInventory =
    hasSemanticConcept(tokens, "qualifier_inventory") ||
    hasSemanticConcept(tokens, "facet_model") ||
    asksOrchestraInventory(tokens);
  const asksStatus = hasSemanticConcept(tokens, "qualifier_status");
  if (asksStatus && !asksInventory) {
    return "orchestra_status";
  }
  if (asksInventory || hasSemanticConcept(tokens, "facet_model")) {
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

function buildRoleReply(): ReplyPayload {
  return {
    text: "Tugas saya adalah membantu Anda menyelesaikan pekerjaan dengan cepat dan aman: menjawab pertanyaan, menjalankan tindakan yang diperlukan di workspace ini, dan mengatur pengingat atau automasi saat dibutuhkan.",
  };
}

function buildOrchestraSummary(cfg: OpenClawConfig, runtime?: RuntimeOrchestraState): string {
  const defaults = cfg.agents?.defaults;
  const textPrimary = formatModelLabel(
    runtime?.textPrimary ?? resolveAgentModelPrimaryValue(defaults?.model),
  );
  const textFallbacks = (
    runtime?.textFallbacks && runtime.textFallbacks.length > 0
      ? runtime.textFallbacks
      : resolveAgentModelFallbackValues(defaults?.model)
  )
    .map((entry) => formatModelLabel(entry))
    .filter((entry): entry is string => Boolean(entry));
  const imagePrimary = formatModelLabel(
    runtime?.imagePrimary ?? resolveAgentModelPrimaryValue(defaults?.imageModel),
  );
  const imageFallbacks = (
    runtime?.imageFallbacks && runtime.imageFallbacks.length > 0
      ? runtime.imageFallbacks
      : resolveAgentModelFallbackValues(defaults?.imageModel)
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
  const tokens = tokenizeSelfSemantics(query);
  const wantsGmail = hasSemanticConcept(tokens, "facet_gmail");
  const wantsCalendar = hasSemanticConcept(tokens, "facet_calendar");
  const wantsWebhook = hasSemanticConcept(tokens, "facet_webhook");
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
  agentId?: string;
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
  if (intent === "role") {
    logVerbose("self-facts: matched role intent");
    return {
      directReply: buildRoleReply(),
    };
  }
  logVerbose(`self-facts: matched ${intent} intent`);
  return {
    directReply: buildOrchestraReply(params.cfg, intent, params.runtime),
  };
}
