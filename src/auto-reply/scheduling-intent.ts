import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type {
  PendingSchedulingDeliveryChoice,
  PendingSchedulingIntent,
  PendingSchedulingRoute,
  SessionEntry,
} from "../config/sessions/types.js";
import { resolveDeliveryTarget as resolveCronDeliveryTarget } from "../cron/isolated-agent/delivery-target.js";
import { parseAbsoluteTimeMs } from "../cron/parse.js";
import { logVerbose } from "../globals.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import { readChannelAllowFromStoreSync } from "../pairing/pairing-store.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import {
  tokenizeSemanticText,
  hasSemanticConcept,
  type SemanticToken,
} from "./semantic-concepts.js";
import type { MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

const PENDING_SCHEDULING_TTL_MS = 15 * 60_000;
const SCHEDULING_SEMANTIC_LEXICON = {
  cli_surface: ["cli"],
  cron_surface: [
    "cron",
    "cronjob",
    "job",
    "jobs",
    "jadwal",
    "schedule",
    "schedules",
    "rutin",
    "reminder",
    "reminders",
    "pengingat",
  ],
  heartbeat_surface: ["heartbeat"],
  capability: [
    "bisa",
    "can",
    "could",
    "pakai",
    "use",
    "akses",
    "access",
    "available",
    "tersedia",
    "aktif",
    "enabled",
    "jalan",
    "working",
    "run",
    "status",
  ],
  list_action: ["list", "daftar", "show", "lihat", "see", "apa", "available", "tersedia"],
  status_action: ["status", "aktif", "active", "enabled", "jalan", "running", "hidup"],
  remove_action: ["hapus", "remove", "delete", "batalkan", "cancel"],
  update_action: ["ganti", "ubah", "update", "change", "edit"],
  reminder_action: [
    "remind",
    "reminder",
    "ingatkan",
    "pengingat",
    "jadwalkan",
    "schedule",
    "ingatin",
  ],
  contact_action: [
    "chat",
    "ping",
    "kabari",
    "kabarkan",
    "hubungi",
    "contact",
    "reply",
    "balas",
    "kasih tahu",
    "let me know",
  ],
  reminder_recipient: ["saya", "aku", "gue", "gw", "me", "myself"],
  monitoring_action: ["cek", "check", "monitor", "pantau", "review", "watch"],
  monitoring_subject: [
    "email",
    "gmail",
    "calendar",
    "kalender",
    "weather",
    "cuaca",
    "status",
    "uptime",
    "health",
  ],
  direct_reference: [
    "yang",
    "tadi",
    "terakhir",
    "itu",
    "tersebut",
    "last",
    "latest",
    "previous",
    "yang tadi",
    "yang terakhir",
  ],
  notify_action: [
    "balas",
    "reply",
    "kirim",
    "send",
    "kabari",
    "lapor",
    "laporkan",
    "kirim status",
    "send status",
  ],
  delivery_same_chat: [
    "chat ini",
    "chat saja",
    "chat aja",
    "balas chat",
    "balas chat saja",
    "balas ke chat ini",
    "ke sini aja",
    "reply here",
    "back here",
    "yang tadi aja",
    "channel yang sama",
  ],
  delivery_internal: [
    "simpan internal",
    "simpan internal saja",
    "internal saja",
    "internal aja",
    "secara internal",
    "simpan aja",
    "jangan kirim",
    "tanpa kirim",
    "jangan balas",
    "no delivery",
    "dont send",
    "don't send",
  ],
  delivery_webhook: ["webhook"],
  delivery_same_channel: [
    "balas ke yang tadi",
    "ke yang tadi",
    "ke yang sama",
    "channel yang sama",
    "pakai channel yang sama",
  ],
  selection_cancel: ["batal", "cancel", "gak jadi", "ga jadi", "never mind", "abaikan"],
  subject_email_or_calendar: ["email", "gmail", "calendar", "kalender"],
  courtesy: ["boleh", "tolong", "please", "dong"],
  temporal_now: ["sekarang", "now", "right now"],
} satisfies Record<string, readonly string[]>;
const HEARTBEAT_SELECTION_RE = /\bheartbeat\b/i;
const CRON_SELECTION_RE = /\bcron\b/i;
const URL_RE = /https?:\/\/\S+/gi;
const RELATIVE_TIME_RE =
  /\b(?:(?:in)\s+)?(\d+(?:\.\d+)?)\s*(detik|seconds?|secs?|menit|minutes?|mins?|jam|hours?|hari|days?|ms|s|m|h|d)\b(?:\s+lagi)?/i;
const RECURRING_TIME_RE =
  /\b(?:setiap|tiap|every)\s+(\d+(?:\.\d+)?)\s*(detik|seconds?|secs?|menit|minutes?|mins?|jam|hours?|hari|days?|ms|s|m|h|d)\b/i;
const ABSOLUTE_TIME_RE = /\b([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[t\s][0-9:.+-zZ]+)?|[0-9]{10,13})\b/i;
const DAILY_CLOCK_RE =
  /\b(?:setiap|tiap|every)\s+(?:hari|day)\b(?:\s+(?:jam|pukul|at))?\s+(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam|am|pm)?\b/i;
const NATURAL_DAYPART_CLOCK_RE =
  /\b(besok|tomorrow|hari\s+ini|today)\s+(pagi|siang|sore|malam)\s+(?:jam|pukul|at)\s+(\d{1,2})(?::(\d{2}))?\b/i;
const NATURAL_CLOCK_RE =
  /\b(?:(besok|tomorrow|hari\s+ini|today)\s+)?(?:jam|pukul|at)\s+(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam|am|pm)?\b/i;
const REMINDER_PREFIX_RE =
  /^(?:tolong\s+|please\s+)?(?:ingatkan(?:\s+saya)?|buat\s+pengingat|set\s+reminder|remind(?:\s+me)?|chat\s+saya(?:\s+lagi)?|ping\s+saya|kabari(?:kan)?\s+saya|kasih\s+tahu\s+saya|tolong\s+ingetin|hubungi\s+saya)\b/i;
const CONNECTOR_PREFIX_RE = /^(?:untuk|buat|soal|bahwa|agar|supaya|to)\b\s*/i;
const TRIM_FILLER_RE = /\b(?:saja|aja|dong|please|tolong)\b/gi;
const CRON_MUTATION_LOOKUP_IGNORED_TOKENS = new Set([
  "saya",
  "aku",
  "gue",
  "gw",
  "me",
  "my",
  "myself",
  "yang",
  "ini",
  "itu",
  "tersebut",
  "tadi",
  "terakhir",
  "last",
  "latest",
  "previous",
  "aja",
  "saja",
  "baru",
  "barusan",
  "ke",
  "jadi",
  "to",
]);

type CronJobSummary = {
  id: string;
  name?: string;
  enabled?: boolean;
  updatedAtMs?: number;
  schedule?: {
    kind?: string;
    at?: string;
    everyMs?: number;
    expr?: string;
  };
  payload?: {
    kind?: string;
    message?: string;
    request?: {
      url?: string;
    };
  };
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
  };
};

type CronListPage = {
  jobs: CronJobSummary[];
  total: number;
};

type ChannelSessionTargetCandidate = {
  sessionKey: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

type CronStatusSummary = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
};

type SchedulingRuntimeOps = {
  listCronJobs?: (opts?: {
    includeDisabled?: boolean;
    query?: string;
    enabled?: "all" | "enabled" | "disabled";
  }) => Promise<CronListPage>;
  getCronStatus?: () => Promise<CronStatusSummary>;
};

export type DeterministicSchedulingAction =
  | {
      kind: "cron.add";
      params: Record<string, unknown>;
      confirmationText: string;
      rememberCreatedJob?: boolean;
    }
  | {
      kind: "cron.update";
      params: Record<string, unknown>;
      confirmationText: string;
      rememberJobId: string;
    }
  | {
      kind: "cron.remove";
      params: Record<string, unknown>;
      confirmationText: string;
      removedJobId: string;
    }
  | {
      kind: "cron.list";
      params: Record<string, unknown>;
      rememberIfSingleResult?: boolean;
    }
  | {
      kind: "cron.status";
      params: Record<string, unknown>;
    };

export type DeterministicSchedulingContext = {
  directReply?: ReplyPayload;
  sessionPatch?: Partial<SessionEntry>;
  clearPendingScheduling?: boolean;
  resolvedSchedulingAction?: DeterministicSchedulingAction;
};

type SchedulingActionWithConfirmation = Extract<
  DeterministicSchedulingAction,
  { confirmationText: string }
>;

type SchedulingActionBuildSuccess = {
  action: SchedulingActionWithConfirmation;
};

type SchedulingActionBuildClarification = {
  clarification: ReplyPayload;
};

type SchedulingActionBuildResult =
  | SchedulingActionBuildSuccess
  | SchedulingActionBuildClarification;

type ReminderSchedule =
  | {
      mode: "relative";
      delayMs: number;
      originalText: string;
    }
  | {
      mode: "absolute";
      at: string;
      originalText: string;
    }
  | {
      mode: "recurring";
      everyMs: number;
      originalText: string;
    }
  | {
      mode: "cron";
      expr: string;
      originalText: string;
    }
  | {
      mode: "unresolved";
      originalText: string;
    };

type DeliveryResolution =
  | { kind: "cancel" }
  | { kind: "same_chat" }
  | { kind: "internal" }
  | { kind: "webhook"; targetUrl?: string }
  | { kind: "channel"; channel: string }
  | { kind: "none" };

type DeliveryCue = {
  label: string;
  conflictKey: string;
};

type UrlMention = {
  url: string;
  index: number;
  beforeText: string;
  afterText: string;
  contextText: string;
};

type AutomationUrlSlots = {
  actionUrl?: string;
  notifyWebhookUrl?: string;
};

type CueToken = {
  value: string;
  start: number;
  end: number;
};

type CueHit = {
  start: number;
  end: number;
};

const AUTOMATION_ACTION_CUE_TOKENS = new Set([
  "action",
  "aksi",
  "trigger",
  "jalankan",
  "run",
  "nyalakan",
  "matikan",
  "start",
  "stop",
  "call",
  "hit",
  "request",
  "invoke",
  "endpoint",
  "device",
  "alat",
  "api",
  "automation",
]);
const AUTOMATION_NOTIFY_CUE_TOKENS = new Set([
  "notify",
  "notification",
  "status",
  "hasil",
  "ringkasan",
  "summary",
  "report",
  "lapor",
  "laporkan",
  "balas",
  "reply",
  "send",
  "kirim",
  "success",
  "failure",
  "sukses",
  "gagal",
  "kabari",
  "kabarkan",
]);
const AUTOMATION_ACTION_CUE_PHRASES = [
  ["turn", "on"],
  ["turn", "off"],
];
const AUTOMATION_NOTIFY_CUE_PHRASES = [
  ["kirim", "status"],
  ["send", "status"],
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSchedulingQuery(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/[?!,;()[\]{}"']/g, " ")
      .replace(/\bmemakai\b/g, "pakai")
      .replace(/\bgoogle\s*calendar\b/g, "calendar")
      .replace(/\bgoogle\s*chat\b/g, "googlechat"),
  );
}

function tokenizeSchedulingSemantics(query: string): SemanticToken[] {
  return tokenizeSemanticText(query, SCHEDULING_SEMANTIC_LEXICON);
}

function hasSchedulingConcept(tokens: SemanticToken[], concept: string): boolean {
  return hasSemanticConcept(tokens, concept);
}

function hasCronSurface(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "cron_surface");
}

function hasUpdateCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "update_action");
}

function hasRemoveCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "remove_action");
}

function hasListCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "list_action");
}

function hasStatusCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "status_action");
}

function hasReminderActionCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "reminder_action");
}

function hasReminderRecipientCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "reminder_recipient");
}

function hasMonitoringActionCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "monitoring_action");
}

function hasMonitoringSubjectCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "monitoring_subject");
}

function hasDirectReferenceCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "direct_reference");
}

function hasSameChatDeliveryCue(tokens: SemanticToken[]): boolean {
  return (
    hasSchedulingConcept(tokens, "delivery_same_chat") ||
    hasSchedulingConcept(tokens, "delivery_same_channel")
  );
}

function hasInternalDeliveryCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "delivery_internal");
}

function hasWebhookDeliveryCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "delivery_webhook");
}

function hasCancelSelectionCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "selection_cancel");
}

function hasEmailOrCalendarCue(tokens: SemanticToken[]): boolean {
  return hasSchedulingConcept(tokens, "subject_email_or_calendar");
}

function looksLikeCapabilityQuery(tokens: SemanticToken[], subjectConcept: string): boolean {
  return hasSchedulingConcept(tokens, subjectConcept) && hasSchedulingConcept(tokens, "capability");
}

function looksLikeCliCapabilityQuery(query: string): boolean {
  const tokens = tokenizeSchedulingSemantics(query);
  return looksLikeCapabilityQuery(tokens, "cli_surface");
}

function looksLikeCronCapabilityQuery(query: string): boolean {
  const tokens = tokenizeSchedulingSemantics(query);
  return (
    looksLikeCapabilityQuery(tokens, "cron_surface") &&
    !hasListCue(tokens) &&
    !hasStatusCue(tokens) &&
    !hasUpdateCue(tokens) &&
    !hasRemoveCue(tokens)
  );
}

function looksLikeHeartbeatCapabilityQuery(query: string): boolean {
  const tokens = tokenizeSchedulingSemantics(query);
  return looksLikeCapabilityQuery(tokens, "heartbeat_surface");
}

function looksLikeCronStatusQuery(query: string): boolean {
  const tokens = tokenizeSchedulingSemantics(query);
  return (
    hasSchedulingConcept(tokens, "cron_surface") &&
    hasStatusCue(tokens) &&
    !hasListCue(tokens) &&
    !hasUpdateCue(tokens) &&
    !hasRemoveCue(tokens)
  );
}

function looksLikeCronListQuery(query: string): boolean {
  const tokens = tokenizeSchedulingSemantics(query);
  return (
    hasCronSurface(tokens) && hasListCue(tokens) && !hasUpdateCue(tokens) && !hasRemoveCue(tokens)
  );
}

function looksLikeCronRemoveQuery(query: string): boolean {
  const tokens = tokenizeSchedulingSemantics(query);
  return hasCronSurface(tokens) && hasRemoveCue(tokens);
}

function extractUrls(query: string): string[] {
  return Array.from(
    new Set(
      Array.from(
        query.matchAll(URL_RE),
        (match) => match[0]?.replace(/[),.;!?]+$/g, "") ?? "",
      ).filter(Boolean),
    ),
  );
}

function extractUrlMentions(query: string): UrlMention[] {
  const matches = Array.from(query.matchAll(/https?:\/\/\S+/gi));
  return matches
    .map((match) => {
      const raw = match[0] ?? "";
      const url = raw.replace(/[),.;!?]+$/g, "");
      const index = typeof match.index === "number" ? match.index : query.indexOf(raw);
      if (!url || index < 0) {
        return null;
      }
      const end = index + url.length;
      const beforeText = query.slice(Math.max(0, index - 96), index);
      const afterText = query.slice(end, Math.min(query.length, end + 96));
      return {
        url,
        index,
        beforeText,
        afterText,
        contextText: `${beforeText} ${afterText}`.trim(),
      } satisfies UrlMention;
    })
    .filter((value): value is UrlMention => Boolean(value));
}

function isCueTokenChar(char: string | undefined): boolean {
  if (!char) {
    return false;
  }
  const code = char.toLowerCase().charCodeAt(0);
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

function tokenizeCueText(value: string): CueToken[] {
  const lowered = value.toLowerCase();
  const tokens: CueToken[] = [];
  let start = -1;
  for (let index = 0; index <= lowered.length; index += 1) {
    const char = lowered[index];
    const inToken = isCueTokenChar(char);
    if (inToken && start < 0) {
      start = index;
      continue;
    }
    if (!inToken && start >= 0) {
      tokens.push({
        value: lowered.slice(start, index),
        start,
        end: index,
      });
      start = -1;
    }
  }
  return tokens;
}

function collectCueHits(
  value: string,
  cueTokens: Set<string>,
  cuePhrases: string[][] = [],
): CueHit[] {
  const tokens = tokenizeCueText(value);
  const hits: CueHit[] = [];
  for (const token of tokens) {
    if (cueTokens.has(token.value)) {
      hits.push({
        start: token.start,
        end: token.end,
      });
    }
  }
  for (const phrase of cuePhrases) {
    const phraseSize = phrase.length;
    for (let index = 0; index <= tokens.length - phraseSize; index += 1) {
      const phraseMatches = phrase.every((part, offset) => tokens[index + offset]?.value === part);
      if (!phraseMatches) {
        continue;
      }
      const first = tokens[index];
      const last = tokens[index + phraseSize - 1];
      if (first && last) {
        hits.push({
          start: first.start,
          end: last.end,
        });
      }
    }
  }
  return hits.toSorted((left, right) => left.start - right.start);
}

function hasCueHit(value: string, cueTokens: Set<string>, cuePhrases: string[][] = []): boolean {
  return collectCueHits(value, cueTokens, cuePhrases).length > 0;
}

function scoreCueDistance(distance: number | undefined, direction: "before" | "after"): number {
  if (distance == null || distance < 0) {
    return 0;
  }
  if (direction === "before") {
    if (distance <= 12) {
      return 4;
    }
    if (distance <= 24) {
      return 3;
    }
    if (distance <= 48) {
      return 2;
    }
    if (distance <= 72) {
      return 1;
    }
    return 0;
  }
  if (distance <= 12) {
    return 1;
  }
  if (distance <= 24) {
    return 0.5;
  }
  return 0;
}

function scoreCueWindow(
  beforeText: string,
  afterText: string,
  cueTokens: Set<string>,
  cuePhrases: string[][] = [],
): number {
  const beforeHits = collectCueHits(beforeText, cueTokens, cuePhrases);
  const afterHits = collectCueHits(afterText, cueTokens, cuePhrases);
  const lastBefore = beforeHits.at(-1);
  const firstAfter = afterHits[0];
  return (
    scoreCueDistance(lastBefore ? beforeText.length - lastBefore.end : undefined, "before") +
    scoreCueDistance(firstAfter?.start, "after")
  );
}

function scoreAutomationUrlMention(mention: UrlMention): {
  actionScore: number;
  notifyScore: number;
} {
  return {
    actionScore: scoreCueWindow(
      mention.beforeText,
      mention.afterText,
      AUTOMATION_ACTION_CUE_TOKENS,
      AUTOMATION_ACTION_CUE_PHRASES,
    ),
    notifyScore: scoreCueWindow(
      mention.beforeText,
      mention.afterText,
      AUTOMATION_NOTIFY_CUE_TOKENS,
      AUTOMATION_NOTIFY_CUE_PHRASES,
    ),
  };
}

function resolveAutomationUrlSlots(query: string): AutomationUrlSlots {
  const mentions = extractUrlMentions(query);
  if (mentions.length === 0) {
    return {};
  }

  const scored = mentions.map((mention) => ({
    ...mention,
    ...scoreAutomationUrlMention(mention),
  }));
  const explicitNotify = scored.filter(
    (mention) => mention.notifyScore > mention.actionScore && mention.notifyScore > 0,
  );
  const explicitAction = scored.filter(
    (mention) => mention.actionScore > mention.notifyScore && mention.actionScore > 0,
  );

  if (scored.length === 1) {
    const only = scored[0];
    if (only && only.notifyScore > only.actionScore && only.notifyScore > 0) {
      return { notifyWebhookUrl: only.url };
    }
    return { actionUrl: only?.url };
  }

  const actionMention =
    explicitAction[0] ??
    (explicitNotify.length > 0
      ? scored.find(
          (mention) =>
            !explicitNotify.some(
              (notifyMention) =>
                notifyMention.index === mention.index && notifyMention.url === mention.url,
            ),
        )
      : scored[0]);
  const notifyMention = scored.find(
    (mention) =>
      actionMention !== undefined &&
      mention.index !== actionMention.index &&
      mention.url !== actionMention.url &&
      mention.notifyScore > mention.actionScore &&
      mention.notifyScore > 0,
  );

  return {
    actionUrl: actionMention?.url,
    notifyWebhookUrl:
      notifyMention && notifyMention.url !== actionMention?.url ? notifyMention.url : undefined,
  };
}

function normalizeDurationUnit(unit: string): "ms" | "s" | "m" | "h" | "d" {
  const lowered = unit.toLowerCase();
  if (
    lowered === "detik" ||
    lowered.startsWith("sec") ||
    lowered === "seconds" ||
    lowered === "s"
  ) {
    return "s";
  }
  if (
    lowered === "menit" ||
    lowered.startsWith("min") ||
    lowered === "minutes" ||
    lowered === "m"
  ) {
    return "m";
  }
  if (lowered === "jam" || lowered.startsWith("hour") || lowered === "h") {
    return "h";
  }
  if (lowered === "hari" || lowered.startsWith("day") || lowered === "d") {
    return "d";
  }
  return "ms";
}

function formatDurationText(durationMs: number): string {
  if (durationMs % 86_400_000 === 0) {
    return `${durationMs / 86_400_000} hari`;
  }
  if (durationMs % 3_600_000 === 0) {
    return `${durationMs / 3_600_000} jam`;
  }
  if (durationMs % 60_000 === 0) {
    return `${durationMs / 60_000} menit`;
  }
  if (durationMs % 1_000 === 0) {
    return `${durationMs / 1_000} detik`;
  }
  return `${durationMs} ms`;
}

function resolveClockHour(hour: number, rawPeriod?: string): number | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  const period = rawPeriod?.trim().toLowerCase();
  if (!period) {
    return hour;
  }
  if (period === "am") {
    return hour === 12 ? 0 : hour;
  }
  if (period === "pm") {
    if (hour > 12) {
      return hour;
    }
    return hour === 12 ? 12 : hour + 12;
  }
  if (period === "pagi") {
    if (hour > 12) {
      return null;
    }
    return hour === 12 ? 0 : hour;
  }
  if (period === "siang") {
    if (hour > 23) {
      return null;
    }
    if (hour === 12) {
      return 12;
    }
    return hour >= 1 && hour <= 10 ? hour + 12 : hour;
  }
  if (period === "sore") {
    if (hour > 23) {
      return null;
    }
    return hour >= 1 && hour <= 11 ? hour + 12 : hour;
  }
  if (period === "malam") {
    if (hour > 23) {
      return null;
    }
    if (hour >= 1 && hour <= 4) {
      return hour;
    }
    return hour >= 5 && hour <= 11 ? hour + 12 : hour;
  }
  return hour;
}

function buildAbsoluteClockSchedule(params: {
  hour: number;
  minute?: number;
  dayWord?: string;
  period?: string;
  originalText: string;
  nowMs?: number;
}): ReminderSchedule {
  const resolvedHour = resolveClockHour(params.hour, params.period);
  const minute = params.minute ?? 0;
  if (resolvedHour == null || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return {
      mode: "unresolved",
      originalText: params.originalText,
    };
  }
  const now = new Date(params.nowMs ?? Date.now());
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setHours(resolvedHour, minute, 0, 0);

  const dayWord = params.dayWord?.trim().toLowerCase();
  if (dayWord === "besok" || dayWord === "tomorrow") {
    candidate.setDate(candidate.getDate() + 1);
  } else if (!(dayWord === "hari ini" || dayWord === "today")) {
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return {
    mode: "absolute",
    at: candidate.toISOString(),
    originalText: params.originalText,
  };
}

function buildDailyClockCronSchedule(params: {
  hour: number;
  minute?: number;
  period?: string;
  originalText: string;
}): ReminderSchedule {
  const resolvedHour = resolveClockHour(params.hour, params.period);
  const minute = params.minute ?? 0;
  if (resolvedHour == null || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return {
      mode: "unresolved",
      originalText: params.originalText,
    };
  }
  return {
    mode: "cron",
    expr: `${minute} ${resolvedHour} * * *`,
    originalText: params.originalText,
  };
}

function stripDeliveryPhrases(value: string): string {
  const withoutUrls = extractUrls(value).reduce((next, url) => next.replace(url, " "), value);
  return normalizeWhitespace(
    withoutUrls
      .replace(
        /\b(?:dan|lalu|terus|kemudian)?\s*(?:balas|reply)(?:\s+(?:kembali|lagi|again))?\s+(?:ke\s+)?(?:chat\s+ini|sini|here)\b/gi,
        " ",
      )
      .replace(/\b(?:chat\s+ini|chat\s+saja|chat\s+aja)\b/gi, " ")
      .replace(
        /\b(?:dan|lalu|terus|kemudian)?\s*simpan(?:\s+secara)?\s+internal(?:\s+(?:saja|aja))?\b/gi,
        " ",
      )
      .replace(/\b(?:dan|lalu|terus|kemudian)?\s*internal\s+(?:saja|aja)\b/gi, " ")
      .replace(/\b(?:dan|lalu|terus|kemudian)?\s*secara\s+internal\b/gi, " ")
      .replace(/\b(?:dan|lalu|terus|kemudian)?\s*simpan\s+aja\b/gi, " ")
      .replace(/\b(?:jangan\s+kirim|tanpa\s+kirim|no\s+delivery)\b/gi, " ")
      .replace(/\b(?:via|dengan|pakai|ke)\s+webhook\b/gi, " ")
      .replace(/\b(?:webhook|channel\s+yang\s+sama|yang\s+tadi)\b/gi, " "),
  );
}

function stripSchedulePhrases(value: string): string {
  const stripped = normalizeWhitespace(
    value
      .replace(REMINDER_PREFIX_RE, " ")
      .replace(DAILY_CLOCK_RE, " ")
      .replace(NATURAL_DAYPART_CLOCK_RE, " ")
      .replace(NATURAL_CLOCK_RE, " ")
      .replace(RECURRING_TIME_RE, " ")
      .replace(RELATIVE_TIME_RE, " ")
      .replace(ABSOLUTE_TIME_RE, " ")
      .replace(URL_RE, " ")
      .replace(CONNECTOR_PREFIX_RE, " ")
      .replace(/^(?:dan|lalu|terus|kemudian)\b/gi, " ")
      .replace(TRIM_FILLER_RE, " "),
  );
  return stripDeliveryPhrases(stripped);
}

function trimReminderSubject(value: string): string {
  let next = normalizeWhitespace(value);
  while (next) {
    const trimmed = normalizeWhitespace(
      next
        .replace(/^(?:dan|lalu|terus|kemudian)\b\s*/i, " ")
        .replace(/^(?:pada|on)\b\s*/i, " ")
        .replace(/^(?:untuk|buat|soal|bahwa|agar|supaya|to)\b\s*/i, " ")
        .replace(/^(?:saya|aku|gue|gw|me|myself)\b\s*/i, " "),
    );
    if (trimmed === next) {
      break;
    }
    next = trimmed;
  }
  return normalizeWhitespace(
    next.replace(/\b(?:dan|lalu|terus|kemudian|and|then|again)\b\s*$/i, " "),
  );
}

function buildReminderText(query: string): string {
  const subject = trimReminderSubject(stripSchedulePhrases(query).replace(/\s+/g, " ").trim());
  if (!subject) {
    return "Ini pengingat Anda.";
  }
  if (/^[a-z0-9-]+$/i.test(subject) && subject.split(" ").length <= 3) {
    return `Waktunya ${subject}!`;
  }
  return `Pengingat: ${subject}`;
}

function buildJobName(kind: "reminder" | "periodic_monitoring", query: string): string {
  const base = trimReminderSubject(stripSchedulePhrases(query));
  if (!base) {
    return kind === "reminder" ? "Reminder" : "Monitoring";
  }
  const label = base.length > 40 ? `${base.slice(0, 39)}…` : base;
  return kind === "reminder" ? `Reminder: ${label}` : `Monitoring: ${label}`;
}

function parseReminderSchedule(query: string, nowMs = Date.now()): ReminderSchedule {
  const dailyClockMatch = DAILY_CLOCK_RE.exec(query);
  if (dailyClockMatch?.[1]) {
    return buildDailyClockCronSchedule({
      hour: Number(dailyClockMatch[1]),
      minute: dailyClockMatch[2] ? Number(dailyClockMatch[2]) : 0,
      period: dailyClockMatch[3],
      originalText: dailyClockMatch[0].trim(),
    });
  }

  const recurringMatch = RECURRING_TIME_RE.exec(query);
  if (recurringMatch?.[1] && recurringMatch[2]) {
    const everyMs = parseDurationMs(
      `${recurringMatch[1]}${normalizeDurationUnit(recurringMatch[2])}`,
      { defaultUnit: "m" },
    );
    return {
      mode: "recurring",
      everyMs,
      originalText: recurringMatch[0].trim(),
    };
  }

  const naturalDaypartMatch = NATURAL_DAYPART_CLOCK_RE.exec(query);
  if (naturalDaypartMatch?.[1] && naturalDaypartMatch[3]) {
    return buildAbsoluteClockSchedule({
      dayWord: naturalDaypartMatch[1],
      period: naturalDaypartMatch[2],
      hour: Number(naturalDaypartMatch[3]),
      minute: naturalDaypartMatch[4] ? Number(naturalDaypartMatch[4]) : 0,
      originalText: naturalDaypartMatch[0].trim(),
      nowMs,
    });
  }

  const naturalClockMatch = NATURAL_CLOCK_RE.exec(query);
  if (naturalClockMatch?.[2]) {
    return buildAbsoluteClockSchedule({
      dayWord: naturalClockMatch[1],
      hour: Number(naturalClockMatch[2]),
      minute: naturalClockMatch[3] ? Number(naturalClockMatch[3]) : 0,
      period: naturalClockMatch[4],
      originalText: naturalClockMatch[0].trim(),
      nowMs,
    });
  }

  const relativeMatch = RELATIVE_TIME_RE.exec(query);
  if (relativeMatch?.[1] && relativeMatch[2]) {
    const delayMs = parseDurationMs(
      `${relativeMatch[1]}${normalizeDurationUnit(relativeMatch[2])}`,
      { defaultUnit: "m" },
    );
    return {
      mode: "relative",
      delayMs,
      originalText: relativeMatch[0].trim(),
    };
  }

  const absoluteMatch = ABSOLUTE_TIME_RE.exec(query);
  if (absoluteMatch?.[1]) {
    const parsed = parseAbsoluteTimeMs(absoluteMatch[1]);
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > nowMs) {
      return {
        mode: "absolute",
        at: new Date(parsed).toISOString(),
        originalText: absoluteMatch[0].trim(),
      };
    }
  }

  return {
    mode: "unresolved",
    originalText: query,
  };
}

function detectDirectDeliveryResolution(query: string): DeliveryResolution {
  const tokens = tokenizeSchedulingSemantics(query);
  if (hasCancelSelectionCue(tokens)) {
    return { kind: "cancel" };
  }
  if (hasSameChatDeliveryCue(tokens)) {
    return { kind: "same_chat" };
  }
  if (hasInternalDeliveryCue(tokens)) {
    return { kind: "internal" };
  }
  return { kind: "none" };
}

function detectDeliveryResolution(query: string): DeliveryResolution {
  const direct = detectDirectDeliveryResolution(query);
  if (direct.kind !== "none") {
    return direct;
  }
  const tokens = tokenizeSchedulingSemantics(query);
  if (hasWebhookDeliveryCue(tokens) || extractUrls(query).length > 0) {
    const targetUrl = extractUrls(query)[0];
    return { kind: "webhook", targetUrl };
  }
  return { kind: "none" };
}

function hasAutomationActionCue(query: string): boolean {
  return hasCueHit(query, AUTOMATION_ACTION_CUE_TOKENS, AUTOMATION_ACTION_CUE_PHRASES);
}

function hasAutomationNotifyCue(query: string): boolean {
  return hasCueHit(query, AUTOMATION_NOTIFY_CUE_TOKENS, AUTOMATION_NOTIFY_CUE_PHRASES);
}

function hasBareDailyRecurringCue(query: string): boolean {
  const tokens = tokenizeCueText(query).map((token) => token.value);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const first = tokens[index];
    const second = tokens[index + 1];
    if (
      (first === "setiap" || first === "tiap" || first === "every") &&
      (second === "hari" || second === "day")
    ) {
      return true;
    }
  }
  return false;
}

function buildChannelMatchVariants(raw: string): string[] {
  const base = normalizeWhitespace(raw.toLowerCase());
  const compact = base.replace(/\s+/g, "");
  return Array.from(
    new Set([
      base,
      compact,
      base.replace(/\s+/g, "-"),
      base.replace(/\s+/g, "_"),
      compact.replace(/[_-]/g, ""),
    ]),
  ).filter(Boolean);
}

function collectChannelPhrases(query: string, maxWords = 3): string[] {
  const tokens = query.split(/\s+/).filter(Boolean);
  const phrases: string[] = [];
  for (let size = Math.min(maxWords, tokens.length); size >= 1; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      phrases.push(tokens.slice(index, index + size).join(" "));
    }
  }
  return Array.from(new Set(phrases));
}

async function resolveConfiguredChannelSelection(params: {
  cfg: OpenClawConfig;
  query: string;
  pending?: PendingSchedulingIntent;
  ctx?: MsgContext;
}): Promise<string | undefined> {
  const configuredChannels = new Set(await listConfiguredMessageChannels(params.cfg));
  const currentRoute =
    params.pending?.originatingRoute?.channel ??
    (params.ctx ? resolveCurrentReturnRoute(params.ctx)?.channel : undefined);
  if (currentRoute && currentRoute !== INTERNAL_MESSAGE_CHANNEL) {
    configuredChannels.add(currentRoute);
  }
  if (configuredChannels.size === 0) {
    return undefined;
  }
  for (const phrase of collectChannelPhrases(params.query)) {
    for (const variant of buildChannelMatchVariants(phrase)) {
      const resolved = normalizeMessageChannel(variant);
      if (resolved && configuredChannels.has(resolved)) {
        return resolved;
      }
    }
  }
  return undefined;
}

async function detectDeliveryResolutionFromRuntime(params: {
  cfg: OpenClawConfig;
  query: string;
  rawQuery?: string;
  pending?: PendingSchedulingIntent;
  ctx?: MsgContext;
}): Promise<DeliveryResolution> {
  const direct = detectDeliveryResolution(params.query);
  if (direct.kind === "same_chat") {
    return direct;
  }
  if (direct.kind !== "none") {
    return direct;
  }
  const channel = await resolveConfiguredChannelSelection(params);
  if (!channel) {
    return { kind: "none" };
  }
  return {
    kind: "channel",
    channel,
  };
}

function buildDeliveryRouteConflictKey(route?: PendingSchedulingRoute | null): string | undefined {
  if (!route?.channel || !route.to) {
    return undefined;
  }
  return `announce:${route.channel}:${route.to}:${route.accountId ?? ""}:${route.threadId ?? ""}:${route.replyToId ?? ""}`;
}

function dedupeDeliveryCues(cues: DeliveryCue[]): DeliveryCue[] {
  const seen = new Set<string>();
  const deduped: DeliveryCue[] = [];
  for (const cue of cues) {
    if (seen.has(cue.conflictKey)) {
      continue;
    }
    seen.add(cue.conflictKey);
    deduped.push(cue);
  }
  return deduped;
}

async function buildReminderDeliveryConflictReply(params: {
  cfg: OpenClawConfig;
  query: string;
  rawQuery: string;
  pending?: PendingSchedulingIntent;
  ctx?: MsgContext;
}): Promise<ReplyPayload | undefined> {
  const route =
    params.pending?.originatingRoute ?? (params.ctx ? resolveCurrentReturnRoute(params.ctx) : null);
  const routeConflictKey = buildDeliveryRouteConflictKey(route);
  const cues: DeliveryCue[] = [];

  const tokens = tokenizeSchedulingSemantics(params.query);
  if (hasSameChatDeliveryCue(tokens)) {
    cues.push({
      label: "balas ke chat ini",
      conflictKey: routeConflictKey ?? "same_chat",
    });
  }
  if (hasInternalDeliveryCue(tokens)) {
    cues.push({
      label: "simpan internal saja",
      conflictKey: "none",
    });
  }
  if (hasWebhookDeliveryCue(tokens) || extractUrls(params.rawQuery).length > 0) {
    const targetUrl = extractUrls(params.rawQuery)[0];
    cues.push({
      label: targetUrl ? `webhook ${targetUrl}` : "webhook",
      conflictKey: targetUrl ? `webhook:${targetUrl}` : "webhook",
    });
  }
  const configuredChannel = await resolveConfiguredChannelSelection({
    cfg: params.cfg,
    query: params.query,
    pending: params.pending,
    ctx: params.ctx,
  });
  if (configuredChannel) {
    cues.push({
      label: formatChannelLabel(configuredChannel),
      conflictKey:
        route?.channel === configuredChannel && routeConflictKey
          ? routeConflictKey
          : `channel:${configuredChannel}`,
    });
  }

  const deduped = dedupeDeliveryCues(cues);
  if (deduped.length <= 1) {
    return undefined;
  }
  const labels = deduped.map((cue) => cue.label).join(", ");
  return {
    text: `Saya melihat lebih dari satu target delivery untuk reminder itu (${labels}). Pilih satu saja.`,
  };
}

async function detectAutomationNotifyResolutionFromRuntime(params: {
  cfg: OpenClawConfig;
  query: string;
  rawQuery: string;
  pending?: PendingSchedulingIntent;
  ctx?: MsgContext;
  actionUrl?: string;
}): Promise<DeliveryResolution> {
  const direct = detectDirectDeliveryResolution(params.query);
  if (direct.kind !== "none") {
    return direct;
  }
  const slots = resolveAutomationUrlSlots(params.rawQuery);
  if (slots.notifyWebhookUrl && slots.notifyWebhookUrl !== params.actionUrl) {
    return {
      kind: "webhook",
      targetUrl: slots.notifyWebhookUrl,
    };
  }
  const tokens = tokenizeSchedulingSemantics(params.query);
  if (
    (hasWebhookDeliveryCue(tokens) || extractUrls(params.rawQuery).length > 0) &&
    hasAutomationNotifyCue(params.query)
  ) {
    return {
      kind: "webhook",
    };
  }
  const channel = await resolveConfiguredChannelSelection(params);
  if (!channel) {
    return { kind: "none" };
  }
  return {
    kind: "channel",
    channel,
  };
}

function probeOpenClawCliAvailable(): boolean {
  const probe = spawnSync("bash", ["-lc", "command -v openclaw >/dev/null 2>&1"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (probe.status === 0) {
    return true;
  }
  return fs.existsSync(path.join(process.cwd(), "openclaw.mjs"));
}

function resolveCurrentReturnRoute(ctx: MsgContext): PendingSchedulingRoute | null {
  const sessionDeliveryInfo =
    typeof ctx.SessionKey === "string" && ctx.SessionKey.trim()
      ? extractDeliveryInfo(ctx.SessionKey)
      : { deliveryContext: undefined, threadId: undefined };
  const sessionChannel = normalizeMessageChannel(sessionDeliveryInfo.deliveryContext?.channel);
  const originatingChannel = normalizeMessageChannel(ctx.OriginatingChannel);
  const prefersSessionRoute =
    Boolean(sessionChannel) &&
    (originatingChannel === INTERNAL_MESSAGE_CHANNEL ||
      (typeof ctx.OriginatingTo === "string" &&
        typeof ctx.SessionKey === "string" &&
        ctx.OriginatingTo.trim() === ctx.SessionKey.trim()));
  const channel =
    (prefersSessionRoute ? sessionChannel : undefined) ??
    originatingChannel ??
    sessionChannel ??
    normalizeMessageChannel(ctx.Provider ?? ctx.Surface);
  if (!channel) {
    return null;
  }
  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    const sessionKey = typeof ctx.SessionKey === "string" ? ctx.SessionKey.trim() : "";
    if (!sessionKey) {
      return null;
    }
    return {
      channel,
      to: sessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      replyToId: ctx.ReplyToId,
    };
  }
  const to =
    (prefersSessionRoute ? sessionDeliveryInfo.deliveryContext?.to : undefined) ??
    ctx.OriginatingTo ??
    sessionDeliveryInfo.deliveryContext?.to ??
    ctx.To ??
    ctx.From;
  if (!to || !isDeliverableMessageChannel(channel)) {
    return null;
  }
  return {
    channel,
    to,
    accountId:
      (prefersSessionRoute ? sessionDeliveryInfo.deliveryContext?.accountId : undefined) ??
      ctx.AccountId ??
      sessionDeliveryInfo.deliveryContext?.accountId,
    threadId:
      (prefersSessionRoute ? sessionDeliveryInfo.threadId : undefined) ??
      ctx.MessageThreadId ??
      sessionDeliveryInfo.threadId,
    replyToId: ctx.ReplyToId,
  };
}

function formatChannelLabel(channel: string): string {
  return channel === "googlechat" ? "Google Chat" : channel;
}

async function buildDeliveryOptions(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): Promise<string[]> {
  const options: string[] = [];
  const currentRoute = resolveCurrentReturnRoute(params.ctx);
  if (
    currentRoute &&
    (await canDeliverBackToCurrentRoute({
      cfg: params.cfg,
      ctx: params.ctx,
      route: currentRoute,
    }))
  ) {
    options.push("balas kembali ke chat ini");
  }

  const configuredChannels = await listConfiguredMessageChannels(params.cfg);
  const otherChannels = configuredChannels.filter(
    (channel) => !currentRoute || channel !== currentRoute.channel,
  );
  if (otherChannels.length > 0) {
    options.push(
      `kirim ke channel yang terhubung (${otherChannels.map(formatChannelLabel).join(", ")})`,
    );
  }

  options.push("kirim ke webhook");
  options.push("simpan internal saja");
  return options;
}

async function buildAllowedDeliveryChoices(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): Promise<PendingSchedulingDeliveryChoice[]> {
  const allowed: PendingSchedulingDeliveryChoice[] = ["webhook", "internal"];
  const currentRoute = resolveCurrentReturnRoute(params.ctx);
  if (
    currentRoute &&
    (await canDeliverBackToCurrentRoute({
      cfg: params.cfg,
      ctx: params.ctx,
      route: currentRoute,
    }))
  ) {
    allowed.unshift("same_chat");
  }
  const configuredChannels = await listConfiguredMessageChannels(params.cfg);
  if (configuredChannels.length > 0) {
    const insertAt = allowed.includes("same_chat") ? 1 : 0;
    allowed.splice(insertAt, 0, "configured_channel");
  }
  return Array.from(new Set(allowed));
}

async function buildReminderClarification(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  query: string;
  periodicMonitoring?: boolean;
}): Promise<ReplyPayload> {
  const options = await buildDeliveryOptions({
    cfg: params.cfg,
    ctx: params.ctx,
  });
  const intro = params.periodicMonitoring
    ? "Itu lebih cocok sebagai heartbeat karena sifatnya monitoring berkala."
    : "Bisa, tetapi saya perlu target pengingatnya terlebih dulu.";
  const deliveryLine = `Pilih salah satu: ${options.join(", ")}.`;
  const tokens = tokenizeSchedulingSemantics(params.query);
  const capabilityLine = hasEmailOrCalendarCue(tokens)
    ? " Email atau calendar langsung belum menjadi target cron bawaan saat ini."
    : "";
  return {
    text: `${intro} ${deliveryLine}${capabilityLine}`,
  };
}

function buildCliCapabilityReply(cfg: OpenClawConfig): ReplyPayload {
  const openclawCliAvailable = probeOpenClawCliAvailable();
  const cronEnabled = cfg.cron?.enabled !== false;
  return {
    text: `Saya bisa menjalankan perintah shell. CLI OpenClaw ${openclawCliAvailable ? "tersedia" : "tidak tersedia sebagai perintah langsung"} di runtime ini. Cron ${cronEnabled ? "juga tersedia." : "sedang nonaktif."}`,
  };
}

function buildHeartbeatCapabilityReply(cfg: OpenClawConfig): ReplyPayload {
  const heartbeatEnabled = cfg.agents?.defaults?.heartbeat !== undefined;
  return {
    text: heartbeatEnabled
      ? "Heartbeat tersedia di runtime ini."
      : "Heartbeat belum dikonfigurasi khusus di runtime ini, tetapi mekanismenya tersedia.",
  };
}

async function buildCronCapabilityReply(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  query: string;
}): Promise<ReplyPayload> {
  const cronEnabled = params.cfg.cron?.enabled !== false;
  if (!cronEnabled) {
    return {
      text: "Cron sedang nonaktif di runtime ini.",
    };
  }
  const options = await buildDeliveryOptions(params);
  const tokens = tokenizeSchedulingSemantics(params.query);
  const capabilityLine = hasEmailOrCalendarCue(tokens)
    ? " Email atau calendar langsung belum menjadi target cron bawaan saat ini."
    : "";
  return {
    text: `Ya, cron tersedia di runtime ini. Untuk reminder, saya masih perlu targetnya: ${options.join(", ")}.${capabilityLine}`,
  };
}

function buildPendingSchedulingIntent(params: {
  kind: PendingSchedulingIntent["kind"];
  rawRequest: string;
  normalizedRequest: string;
  schedule: ReminderSchedule;
  recommendedExecutor: PendingSchedulingIntent["recommendedExecutor"];
  originatingRoute?: PendingSchedulingIntent["originatingRoute"];
  allowedDeliveryChoices: PendingSchedulingDeliveryChoice[];
}): PendingSchedulingIntent {
  const now = Date.now();
  return {
    kind: params.kind,
    rawRequest: params.rawRequest,
    normalizedRequest: params.normalizedRequest,
    schedule: params.schedule,
    recommendedExecutor: params.recommendedExecutor,
    originatingRoute: params.originatingRoute,
    allowedDeliveryChoices: params.allowedDeliveryChoices,
    createdAt: now,
    expiresAt: now + PENDING_SCHEDULING_TTL_MS,
  };
}

function buildPendingExpiredReply(): ReplyPayload {
  return {
    text: "Permintaan pengingat sebelumnya sudah kedaluwarsa. Tolong kirim ulang waktu pengingatnya.",
  };
}

function buildPendingCanceledReply(): ReplyPayload {
  return {
    text: "Baik, pengingat tertunda tadi saya batalkan.",
  };
}

function isSelectionAllowed(
  pending: PendingSchedulingIntent,
  selection: DeliveryResolution,
): boolean {
  switch (selection.kind) {
    case "cancel":
    case "none":
      return true;
    case "same_chat":
      return pending.allowedDeliveryChoices.includes("same_chat");
    case "channel":
      return pending.allowedDeliveryChoices.includes("configured_channel");
    case "webhook":
      return pending.allowedDeliveryChoices.includes("webhook");
    case "internal":
      return pending.allowedDeliveryChoices.includes("internal");
  }
}

async function buildDisallowedDeliveryReply(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  pending: PendingSchedulingIntent;
}): Promise<ReplyPayload> {
  const clarification = await buildReminderClarification({
    cfg: params.cfg,
    ctx: params.ctx,
    query: params.pending.rawRequest,
    periodicMonitoring: params.pending.kind === "periodic_monitoring",
  });
  return {
    text: `Pilihan itu belum tersedia untuk permintaan ini. ${clarification.text}`,
  };
}

function buildReminderPrompt(reminderText: string): string {
  return `Kirim pengingat ini sekarang. Balas dengan tepat teks berikut dan jangan tambah apa pun:\n${reminderText}`;
}

function buildMonitoringPrompt(requestText: string): string {
  return `Lakukan monitoring sesuai permintaan ini dan kirim ringkasan singkat bila ada temuan relevan:\n${requestText}`;
}

type ResolvedDeliveryTargetDetails =
  | {
      mode: "none";
    }
  | {
      mode: "webhook";
      to: string;
    }
  | {
      mode: "announce";
      channel: string;
      to: string;
      accountId?: string;
      threadId?: string | number;
      replyToId?: string;
    };

function buildPendingContextQuery(pending: PendingSchedulingIntent, rawFollowup: string): string {
  return normalizeWhitespace([pending.rawRequest, rawFollowup].filter(Boolean).join(" "));
}

function buildResolvedSchedule(
  schedule: ReminderSchedule,
  nowMs = Date.now(),
): { schedule: Record<string, unknown>; deleteAfterRun: boolean } | null {
  if (schedule.mode === "relative") {
    return {
      schedule: {
        kind: "at",
        at: new Date(nowMs + schedule.delayMs).toISOString(),
      },
      deleteAfterRun: true,
    };
  }
  if (schedule.mode === "absolute") {
    return {
      schedule: {
        kind: "at",
        at: schedule.at,
      },
      deleteAfterRun: true,
    };
  }
  if (schedule.mode === "recurring") {
    return {
      schedule: {
        kind: "every",
        everyMs: schedule.everyMs,
      },
      deleteAfterRun: false,
    };
  }
  if (schedule.mode === "cron") {
    return {
      schedule: {
        kind: "cron",
        expr: schedule.expr,
      },
      deleteAfterRun: false,
    };
  }
  return null;
}

function formatReminderScheduleDescription(schedule: ReminderSchedule): string {
  if (schedule.mode === "relative") {
    return `dalam ${formatDurationText(schedule.delayMs)}`;
  }
  if (schedule.mode === "absolute") {
    const at = new Date(schedule.at);
    return `pada ${at.toLocaleString("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    })}`;
  }
  if (schedule.mode === "recurring") {
    return `setiap ${formatDurationText(schedule.everyMs)}`;
  }
  if (schedule.mode === "cron") {
    return schedule.originalText ? `sesuai jadwal ${schedule.originalText}` : "sesuai jadwal rutin";
  }
  return "sesuai jadwal yang diminta";
}

function buildReminderModeClarification(kind: PendingSchedulingIntent["kind"]): ReplyPayload {
  if (kind === "automation") {
    return {
      text: "Saya masih perlu waktu automation yang jelas dulu, misalnya 2 menit lagi, besok jam 7 pagi, atau setiap hari jam 2 malam.",
    };
  }
  return {
    text:
      kind === "periodic_monitoring"
        ? "Untuk monitoring berkala, saya masih perlu interval yang jelas dulu, misalnya tiap 30 menit."
        : "Saya masih perlu waktu pengingat yang jelas dulu, misalnya 1 menit lagi, besok jam 7 pagi, atau setiap hari jam 2 malam.",
  };
}

function buildAnnounceDeliveryFromRoute(
  route: PendingSchedulingRoute,
): Extract<ResolvedDeliveryTargetDetails, { mode: "announce" }> | null {
  if (!route.channel || !route.to) {
    return null;
  }
  return {
    mode: "announce",
    channel: route.channel,
    to: route.to,
    accountId: route.accountId,
    threadId: route.threadId,
    replyToId: route.replyToId,
  };
}

function buildCurrentRouteUnavailableReply(params: {
  channel: string;
  reason?: string;
}): ReplyPayload {
  const channelLabel = formatChannelLabel(params.channel);
  const detail = params.reason ? ` (${params.reason})` : "";
  return {
    text: `Route chat saat ini memakai ${channelLabel}, tetapi channel itu belum tersedia di runtime ini${detail}. Pilih target lain seperti channel yang terhubung, webhook, atau internal.`,
  };
}

async function resolveCurrentRouteDelivery(params: {
  cfg: OpenClawConfig;
  ctx?: MsgContext;
  route: PendingSchedulingRoute;
  sessionKey?: string;
}): Promise<
  { ok: true; delivery: ResolvedDeliveryTargetDetails } | { ok: false; reply: ReplyPayload }
> {
  const delivery = buildAnnounceDeliveryFromRoute(params.route);
  if (!delivery) {
    return {
      ok: false,
      reply: {
        text: "Saya belum punya route chat yang bisa dipakai. Sebutkan channel atau targetnya dulu.",
      },
    };
  }
  if (delivery.channel === INTERNAL_MESSAGE_CHANNEL) {
    return { ok: true, delivery };
  }
  const configuredChannels = new Set(await listConfiguredMessageChannels(params.cfg));
  if (!configuredChannels.has(delivery.channel)) {
    return {
      ok: false,
      reply: buildCurrentRouteUnavailableReply({
        channel: delivery.channel,
        reason: "channel tidak terkonfigurasi",
      }),
    };
  }
  const sessionKey =
    params.sessionKey?.trim() ??
    (typeof params.ctx?.SessionKey === "string" ? params.ctx.SessionKey.trim() : "");
  if (!sessionKey) {
    return {
      ok: false,
      reply: buildCurrentRouteUnavailableReply({
        channel: delivery.channel,
      }),
    };
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const resolved = await resolveCronDeliveryTarget(params.cfg, agentId, {
    channel: delivery.channel,
    to: delivery.to,
    accountId: delivery.accountId,
    threadId: delivery.threadId,
    replyToId: delivery.replyToId,
    sessionKey,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      reply: buildCurrentRouteUnavailableReply({
        channel: delivery.channel,
        reason: resolved.error.message,
      }),
    };
  }
  return {
    ok: true,
    delivery: {
      mode: "announce",
      channel: resolved.channel,
      to: resolved.to,
      accountId: resolved.accountId,
      threadId: resolved.threadId,
      replyToId: resolved.replyToId,
    },
  };
}

async function canDeliverBackToCurrentRoute(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  route: PendingSchedulingRoute;
}): Promise<boolean> {
  const resolved = await resolveCurrentRouteDelivery({
    cfg: params.cfg,
    ctx: params.ctx,
    route: params.route,
  });
  return resolved.ok;
}

async function resolveNamedChannelTarget(params: {
  selection: Extract<DeliveryResolution, { kind: "channel" }>;
  pending: PendingSchedulingIntent;
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<{ delivery: ResolvedDeliveryTargetDetails } | { clarification: ReplyPayload }> {
  const configuredChannels = new Set(await listConfiguredMessageChannels(params.cfg));
  if (!configuredChannels.has(params.selection.channel)) {
    return {
      clarification: {
        text: `Channel ${params.selection.channel} tidak terkonfigurasi di runtime ini.`,
      },
    };
  }
  const route = params.pending.originatingRoute;
  if (route?.channel === params.selection.channel && route.to) {
    return {
      delivery: {
        mode: "announce",
        channel: params.selection.channel,
        to: route.to,
        accountId: route.accountId,
        threadId: route.threadId,
        replyToId: route.replyToId,
      },
    };
  }
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const resolved = await resolveCronDeliveryTarget(params.cfg, agentId, {
    channel: params.selection.channel,
    sessionKey: params.sessionKey,
  });
  if (resolved.ok) {
    return {
      delivery: {
        mode: "announce",
        channel: resolved.channel,
        to: resolved.to,
        accountId: resolved.accountId,
        threadId: resolved.threadId,
        replyToId: resolved.replyToId,
      },
    };
  }
  const explicitTarget = extractExplicitNamedChannelTarget({
    channel: params.selection.channel,
    query: params.pending.rawRequest,
  });
  if (explicitTarget) {
    const explicitResolved = await resolveCronDeliveryTarget(params.cfg, agentId, {
      channel: params.selection.channel,
      to: explicitTarget,
      sessionKey: params.sessionKey,
    });
    if (explicitResolved.ok) {
      return {
        delivery: {
          mode: "announce",
          channel: explicitResolved.channel,
          to: explicitResolved.to,
          accountId: explicitResolved.accountId,
          threadId: explicitResolved.threadId,
          replyToId: explicitResolved.replyToId,
        },
      };
    }
  }
  const fallback = await resolveNamedChannelFallbackTarget({
    cfg: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
    channel: params.selection.channel,
    query: params.pending.rawRequest,
  });
  if (fallback.kind === "resolved") {
    return {
      delivery: fallback.delivery,
    };
  }
  if (fallback.kind === "ambiguous") {
    return {
      clarification: {
        text: `Saya menemukan lebih dari satu target ${formatChannelLabel(params.selection.channel)} yang valid. Sebutkan targetnya lebih spesifik.`,
      },
    };
  }
  return {
    clarification: {
      text: `Saya bisa memakai ${formatChannelLabel(params.selection.channel)}, tetapi saya masih perlu target ${formatChannelLabel(params.selection.channel)}-nya.`,
    },
  };
}

function collectChannelSessionTargets(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
}): ChannelSessionTargetCandidate[] {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const targets: ChannelSessionTargetCandidate[] = [];
  const seen = new Set<string>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    const deliveryContext = deliveryContextFromSession(entry);
    const channel = normalizeMessageChannel(deliveryContext?.channel);
    const to = deliveryContext?.to;
    if (channel !== params.channel || typeof to !== "string") {
      continue;
    }
    const normalizedTo = to.trim();
    if (!normalizedTo) {
      continue;
    }
    const dedupeKey = [
      normalizedTo,
      deliveryContext?.accountId ?? "",
      deliveryContext?.threadId != null ? String(deliveryContext.threadId) : "",
    ].join("|");
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    targets.push({
      sessionKey,
      to: normalizedTo,
      accountId: deliveryContext?.accountId,
      threadId: deliveryContext?.threadId,
    });
  }
  return targets;
}

function normalizeChannelRecipientIdentity(channel: string, value: string): string {
  let normalized = value.trim().toLowerCase();
  if (!normalized) {
    return normalized;
  }
  const channelPrefix = `${channel.toLowerCase()}:`;
  if (normalized.startsWith(channelPrefix)) {
    normalized = normalized.slice(channelPrefix.length);
  }
  if (normalized.startsWith("user:")) {
    normalized = normalized.slice("user:".length);
  }
  return normalized;
}

async function resolveNamedChannelFallbackTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  channel: string;
  query?: string;
}): Promise<
  | { kind: "resolved"; delivery: ResolvedDeliveryTargetDetails }
  | { kind: "ambiguous" }
  | { kind: "none" }
> {
  const allowFromInputs = readChannelAllowFromStoreSync(params.channel, process.env);
  const allowFromIdentities = new Set(
    allowFromInputs.map((entry) => normalizeChannelRecipientIdentity(params.channel, entry)),
  );
  const sessionTargets = collectChannelSessionTargets(params).filter((target) => {
    if (allowFromIdentities.size === 0) {
      return true;
    }
    return allowFromIdentities.has(normalizeChannelRecipientIdentity(params.channel, target.to));
  });
  const candidateInputs: Array<ChannelSessionTargetCandidate | string> = [
    ...sessionTargets,
    ...allowFromInputs,
  ];
  const hintedCandidates =
    typeof params.query === "string" && params.query.trim()
      ? candidateInputs.filter((candidate) =>
          matchesExplicitNamedChannelCandidate({
            channel: params.channel,
            query: params.query ?? "",
            candidate: typeof candidate === "string" ? candidate : candidate.to,
          }),
        )
      : [];
  const effectiveCandidates = hintedCandidates.length > 0 ? hintedCandidates : candidateInputs;
  const seenCandidates = new Set<string>();
  const seenSessionCandidateIdentities = new Set<string>();
  const validDeliveries: ResolvedDeliveryTargetDetails[] = [];
  const seenResolved = new Set<string>();

  for (const candidate of effectiveCandidates) {
    const isSessionCandidate = typeof candidate !== "string";
    const normalizedCandidate = isSessionCandidate ? candidate.to.trim() : candidate.trim();
    const sessionKey = isSessionCandidate ? candidate.sessionKey : params.sessionKey;
    const normalizedCandidateIdentity = normalizeChannelRecipientIdentity(
      params.channel,
      normalizedCandidate,
    );
    const candidateKey = isSessionCandidate
      ? [
          normalizedCandidateIdentity,
          candidate.accountId ?? "",
          candidate.threadId ?? "",
          sessionKey,
        ].join("|")
      : normalizedCandidateIdentity;
    if (!isSessionCandidate && seenSessionCandidateIdentities.has(normalizedCandidateIdentity)) {
      continue;
    }
    if (!normalizedCandidate || seenCandidates.has(candidateKey)) {
      continue;
    }
    seenCandidates.add(candidateKey);
    if (isSessionCandidate) {
      seenSessionCandidateIdentities.add(normalizedCandidateIdentity);
    }
    const resolved = await resolveCronDeliveryTarget(params.cfg, params.agentId, {
      channel: params.channel,
      to: normalizedCandidate,
      sessionKey,
    });
    if (!resolved.ok) {
      continue;
    }
    const normalizedResolvedTo = normalizeChannelRecipientIdentity(params.channel, resolved.to);
    const resolutionKey = [
      resolved.channel,
      normalizedResolvedTo,
      resolved.accountId ?? "",
      resolved.threadId != null ? String(resolved.threadId) : "",
      resolved.replyToId ?? "",
    ].join("|");
    if (seenResolved.has(resolutionKey)) {
      continue;
    }
    seenResolved.add(resolutionKey);
    validDeliveries.push({
      mode: "announce",
      channel: resolved.channel,
      to: resolved.to,
      accountId: resolved.accountId,
      threadId: resolved.threadId,
      replyToId: resolved.replyToId,
    });
  }

  if (validDeliveries.length === 1 && validDeliveries[0]) {
    return {
      kind: "resolved",
      delivery: validDeliveries[0],
    };
  }
  if (validDeliveries.length > 1) {
    return {
      kind: "ambiguous",
    };
  }
  return {
    kind: "none",
  };
}

function matchesExplicitNamedChannelCandidate(params: {
  channel: string;
  query: string;
  candidate: string;
}): boolean {
  const query = normalizeWhitespace(params.query).toLowerCase();
  const candidate = params.candidate.trim();
  if (!query || !candidate) {
    return false;
  }
  const normalizedIdentity = normalizeChannelRecipientIdentity(params.channel, candidate);
  const variants = new Set(
    [candidate.toLowerCase(), normalizedIdentity, `${params.channel}:${normalizedIdentity}`].filter(
      Boolean,
    ),
  );
  for (const variant of variants) {
    if (query.includes(variant)) {
      return true;
    }
  }
  return false;
}

function extractExplicitNamedChannelTarget(params: {
  channel: string;
  query: string;
}): string | undefined {
  const trimmed = normalizeWhitespace(params.query).replace(/[),.;!?]+$/g, "");
  if (!trimmed) {
    return undefined;
  }

  const prefixedPattern = new RegExp(`\\b${params.channel}\\s*:\\s*([^\\s,;]+)`, "i");
  const prefixedMatch = trimmed.match(prefixedPattern);
  const prefixedTarget = prefixedMatch?.[1]?.trim();
  if (prefixedTarget) {
    return prefixedTarget;
  }

  if (/^[^\s]+$/.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}

function looksLikeCronUpdateQuery(query: string): boolean {
  const tokens = tokenizeSchedulingSemantics(normalizeSchedulingQuery(query));
  const updateIndexes = tokens.flatMap((token, index) =>
    token.concepts.includes("update_action") ? [index] : [],
  );
  if (updateIndexes.length === 0) {
    return false;
  }

  const directReference = hasDirectReferenceCue(tokens);
  for (const updateIndex of updateIndexes) {
    const updateToken = tokens[updateIndex];
    const beforeChar = updateToken && updateToken.start > 0 ? query[updateToken.start - 1] : "";
    const afterChar = updateToken ? (query[updateToken.end] ?? "") : "";
    if (/[-_/]/.test(beforeChar) || /[-_/]/.test(afterChar)) {
      continue;
    }
    const beforeTokenCount = updateIndex;
    const namesCronSurface = tokens
      .slice(Math.max(0, updateIndex - 4), Math.min(tokens.length, updateIndex + 5))
      .some(
        (token) =>
          token.concepts.includes("cron_surface") ||
          ["webhook", "delivery", "channel", "target", "waktu", "schedule", "url", "hook"].includes(
            token.value,
          ),
      );
    if (beforeTokenCount <= 4 || directReference || namesCronSurface) {
      return true;
    }
  }
  return false;
}

async function resolveDeliveryTargetDetails(params: {
  selection: DeliveryResolution;
  pending: PendingSchedulingIntent;
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<{ delivery: ResolvedDeliveryTargetDetails } | { clarification: ReplyPayload }> {
  if (params.selection.kind === "same_chat") {
    if (!params.pending.originatingRoute) {
      return {
        clarification: {
          text: "Saya belum punya route chat yang bisa dipakai. Sebutkan channel atau targetnya dulu.",
        },
      };
    }
    const resolved = await resolveCurrentRouteDelivery({
      cfg: params.cfg,
      route: params.pending.originatingRoute,
      sessionKey: params.sessionKey,
    });
    if (!resolved.ok) {
      return {
        clarification: resolved.reply,
      };
    }
    return { delivery: resolved.delivery };
  }

  if (params.selection.kind === "internal") {
    return {
      delivery: {
        mode: "none",
      },
    };
  }

  if (params.selection.kind === "channel") {
    return await resolveNamedChannelTarget({
      selection: params.selection,
      pending: params.pending,
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
  }

  if (params.selection.kind === "webhook") {
    const targetUrl =
      params.selection.targetUrl ??
      (typeof params.cfg.cron?.webhook === "string" && params.cfg.cron.webhook.trim()
        ? params.cfg.cron.webhook.trim()
        : undefined);
    if (!targetUrl) {
      return {
        clarification: {
          text: "Saya perlu URL webhook-nya dulu untuk target itu.",
        },
      };
    }
    return {
      delivery: {
        mode: "webhook",
        to: targetUrl,
      },
    };
  }

  return {
    clarification: {
      text: "Saya masih perlu target delivery yang jelas dulu.",
    },
  };
}

function formatDeliveryConfirmationTarget(params: {
  selection: DeliveryResolution;
  delivery: ResolvedDeliveryTargetDetails;
}): string {
  if (params.selection.kind === "same_chat") {
    return "di chat ini";
  }
  if (params.selection.kind === "internal") {
    return "secara internal";
  }
  if (params.selection.kind === "channel" && params.delivery.mode === "announce") {
    return `lewat ${formatChannelLabel(params.delivery.channel)}`;
  }
  if (params.selection.kind === "webhook") {
    return "lewat webhook";
  }
  if (params.delivery.mode === "announce") {
    return `lewat ${formatChannelLabel(params.delivery.channel)}`;
  }
  return "sesuai target yang diminta";
}

function detectAutomationMethod(query: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  const tokens = new Set(tokenizeCueText(query).map((token) => token.value));
  if (tokens.has("delete")) {
    return "DELETE";
  }
  if (tokens.has("patch")) {
    return "PATCH";
  }
  if (tokens.has("put")) {
    return "PUT";
  }
  if (tokens.has("get") || tokens.has("cek")) {
    return "GET";
  }
  return "POST";
}

function buildAutomationSummaryLabel(query: string): string {
  const subject = stripSchedulePhrases(query).replace(URL_RE, " ").trim();
  return subject || "scheduled automation";
}

async function buildReminderAction(params: {
  pending: PendingSchedulingIntent;
  selection: DeliveryResolution;
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<SchedulingActionBuildResult> {
  const reminderText = buildReminderText(params.pending.rawRequest);
  const name = buildJobName("reminder", params.pending.rawRequest);
  const resolvedSchedule = buildResolvedSchedule(params.pending.schedule);
  if (!resolvedSchedule) {
    return {
      clarification: buildReminderModeClarification("reminder"),
    };
  }

  const deliveryResult = await resolveDeliveryTargetDetails({
    selection: params.selection,
    pending: params.pending,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if ("clarification" in deliveryResult) {
    return deliveryResult;
  }

  return {
    action: {
      kind: "cron.add",
      confirmationText: `Siap, saya akan mengirim pengingat ${formatDeliveryConfirmationTarget({
        selection: params.selection,
        delivery: deliveryResult.delivery,
      })} ${formatReminderScheduleDescription(params.pending.schedule)}.`,
      rememberCreatedJob: true,
      params: {
        name,
        schedule: resolvedSchedule.schedule,
        sessionTarget: "isolated",
        sessionKey: params.sessionKey,
        deleteAfterRun: resolvedSchedule.deleteAfterRun,
        payload: {
          kind: "agentTurn",
          message: buildReminderPrompt(reminderText),
          thinking: "off",
          lightContext: true,
          timeoutSeconds: 30,
        },
        delivery: deliveryResult.delivery,
      },
    },
  };
}

async function buildPeriodicAction(params: {
  pending: PendingSchedulingIntent;
  selection: DeliveryResolution;
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<SchedulingActionBuildResult> {
  const schedule = params.pending.schedule;
  if (!(schedule.mode === "recurring" || schedule.mode === "cron")) {
    return {
      clarification: buildReminderModeClarification("periodic_monitoring"),
    };
  }

  const monitoringText = buildMonitoringPrompt(params.pending.rawRequest);
  const name = buildJobName("periodic_monitoring", params.pending.rawRequest);
  const resolvedSchedule = buildResolvedSchedule(schedule);
  if (!resolvedSchedule) {
    return {
      clarification: buildReminderModeClarification("periodic_monitoring"),
    };
  }

  if (params.selection.kind === "internal") {
    if (params.pending.recommendedExecutor === "heartbeat" && schedule.mode === "recurring") {
      return {
        action: {
          kind: "cron.add",
          confirmationText: `Siap, saya akan memantau ${formatReminderScheduleDescription(schedule)} secara internal lewat heartbeat.`,
          rememberCreatedJob: true,
          params: {
            name,
            schedule: resolvedSchedule.schedule,
            sessionTarget: "main",
            sessionKey: params.sessionKey,
            wakeMode: "now",
            payload: {
              kind: "systemEvent",
              text: monitoringText,
            },
          },
        },
      };
    }
    return {
      action: {
        kind: "cron.add",
        confirmationText: `Siap, saya akan memantau ${formatReminderScheduleDescription(schedule)} secara internal lewat cron.`,
        rememberCreatedJob: true,
        params: {
          name,
          schedule: resolvedSchedule.schedule,
          sessionTarget: "current",
          sessionKey: params.sessionKey,
          payload: {
            kind: "agentTurn",
            message: monitoringText,
            lightContext: true,
            timeoutSeconds: 60,
          },
          delivery: {
            mode: "none",
          },
        },
      },
    };
  }

  const deliveryResult = await resolveDeliveryTargetDetails({
    selection: params.selection,
    pending: params.pending,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if ("clarification" in deliveryResult) {
    return deliveryResult;
  }

  return {
    action: {
      kind: "cron.add",
      confirmationText: `Siap, saya akan memantau ${formatReminderScheduleDescription(schedule)} dan mengirim hasil ${formatDeliveryConfirmationTarget(
        {
          selection: params.selection,
          delivery: deliveryResult.delivery,
        },
      )}.`,
      rememberCreatedJob: true,
      params: {
        name,
        schedule: resolvedSchedule.schedule,
        sessionTarget: "current",
        sessionKey: params.sessionKey,
        payload: {
          kind: "agentTurn",
          message: monitoringText,
          lightContext: true,
          timeoutSeconds: 60,
        },
        delivery: deliveryResult.delivery,
      },
    },
  };
}

async function buildAutomationAction(params: {
  pending: PendingSchedulingIntent;
  selection: DeliveryResolution;
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<SchedulingActionBuildResult> {
  const resolvedSchedule = buildResolvedSchedule(params.pending.schedule);
  if (!resolvedSchedule) {
    return {
      clarification: buildReminderModeClarification("automation"),
    };
  }

  const actionUrl = resolveAutomationUrlSlots(params.pending.rawRequest).actionUrl;
  if (!actionUrl) {
    return {
      clarification: {
        text: "Saya sudah menangkap jadwal automasinya, tetapi saya masih perlu action webhook URL yang akan dipanggil.",
      },
    };
  }

  if (params.selection.kind === "none") {
    return {
      clarification: {
        text: "Automation butuh dua target yang berbeda: action webhook dan notify target. Saya sudah punya action webhook-nya, tetapi saya masih perlu target notifikasinya secara terpisah.",
      },
    };
  }

  if (
    params.selection.kind === "webhook" &&
    params.selection.targetUrl &&
    params.selection.targetUrl === actionUrl
  ) {
    return {
      clarification: {
        text: "Automation memakai dua target yang berbeda: action webhook dan notify target. Saya sudah punya action webhook-nya, tetapi saya masih perlu target notifikasi yang terpisah, misalnya balas ke chat ini, configured channel, webhook lain, atau internal.",
      },
    };
  }

  const deliveryResult = await resolveDeliveryTargetDetails({
    selection: params.selection,
    pending: params.pending,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if ("clarification" in deliveryResult) {
    return deliveryResult;
  }

  const actionLabel = buildAutomationSummaryLabel(params.pending.rawRequest);
  return {
    action: {
      kind: "cron.add",
      confirmationText: `Siap, saya akan menjalankan automation ${formatReminderScheduleDescription(params.pending.schedule)} dan mengirim status ${formatDeliveryConfirmationTarget(
        {
          selection: params.selection,
          delivery: deliveryResult.delivery,
        },
      )}.`,
      rememberCreatedJob: true,
      params: {
        name: `Automation: ${actionLabel}`,
        schedule: resolvedSchedule.schedule,
        sessionTarget: "isolated",
        sessionKey: params.sessionKey,
        deleteAfterRun: resolvedSchedule.deleteAfterRun,
        payload: {
          kind: "httpAction",
          request: {
            method: detectAutomationMethod(params.pending.rawRequest),
            url: actionUrl,
          },
          success: {
            whenStatus: "2xx",
            summaryText: `Automation selesai: ${actionLabel}`,
          },
          failure: {
            summaryText: `Automation gagal: ${actionLabel}`,
          },
        },
        delivery: deliveryResult.delivery,
      },
    },
  };
}

function looksLikeReminderIntent(query: string, schedule: ReminderSchedule): boolean {
  const tokens = tokenizeSchedulingSemantics(query);
  const hasReminderVerb = hasReminderActionCue(tokens);
  const addressesSelf = hasReminderRecipientCue(tokens);
  const hasSchedule = schedule.mode !== "unresolved" || hasBareDailyRecurringCue(query);
  return (
    hasSchedule &&
    (hasReminderVerb ||
      (hasSchedulingConcept(tokens, "contact_action") && addressesSelf) ||
      (hasSchedulingConcept(tokens, "notify_action") && addressesSelf))
  );
}

function looksLikeAutomationIntent(query: string, schedule: ReminderSchedule): boolean {
  if (schedule.mode === "unresolved") {
    return false;
  }
  if (!hasAutomationActionCue(query)) {
    return false;
  }
  return !looksLikeReminderIntent(query, schedule);
}

function looksLikePeriodicMonitoringIntent(query: string, schedule: ReminderSchedule): boolean {
  if (!(schedule.mode === "recurring" || schedule.mode === "cron")) {
    return false;
  }
  if (looksLikeReminderIntent(query, schedule) || looksLikeAutomationIntent(query, schedule)) {
    return false;
  }
  const tokens = tokenizeSchedulingSemantics(query);
  return hasMonitoringActionCue(tokens) && hasMonitoringSubjectCue(tokens);
}

function hasResolvedSchedulingAction(
  result: SchedulingActionBuildResult,
): result is SchedulingActionBuildSuccess {
  return "action" in result;
}

function buildCronListQuery(query: string): string | undefined {
  const stripped = normalizeWhitespace(
    tokenizeSchedulingSemantics(normalizeSchedulingQuery(query))
      .filter(
        (token) =>
          !token.concepts.includes("cron_surface") &&
          !token.concepts.includes("list_action") &&
          !token.concepts.includes("status_action") &&
          !token.concepts.includes("capability") &&
          !token.concepts.includes("courtesy") &&
          !token.concepts.includes("temporal_now") &&
          !["semua", "all", "yang", "me", "my", "saya", "aku", "gue", "gw"].includes(token.value),
      )
      .map((token) => token.value)
      .join(" "),
  );
  return stripped || undefined;
}

function buildCronMutationLookupQuery(query: string): string | undefined {
  const stripped = normalizeWhitespace(stripDeliveryPhrases(query.replace(URL_RE, " ")));
  const filteredTokens = tokenizeSchedulingSemantics(normalizeSchedulingQuery(stripped))
    .filter(
      (token) =>
        !token.concepts.includes("cron_surface") &&
        !token.concepts.includes("delivery_webhook") &&
        !token.concepts.includes("delivery_same_chat") &&
        !token.concepts.includes("delivery_same_channel") &&
        !token.concepts.includes("delivery_internal") &&
        !token.concepts.includes("update_action") &&
        !token.concepts.includes("remove_action") &&
        !token.concepts.includes("update_target") &&
        !token.concepts.includes("direct_reference") &&
        !CRON_MUTATION_LOOKUP_IGNORED_TOKENS.has(token.value),
    )
    .map((token) => token.value);
  const normalized = normalizeWhitespace(filteredTokens.join(" "));
  return normalized || undefined;
}

async function resolveCronJobForMutation(params: {
  query: string;
  sessionEntry?: SessionEntry;
  runtimeOps?: SchedulingRuntimeOps;
}): Promise<{ job: CronJobSummary } | { clarification: ReplyPayload }> {
  const lastReference = params.sessionEntry?.lastDeterministicCronJob;
  const wantsDirectReference = hasDirectReferenceCue(
    tokenizeSchedulingSemantics(normalizeSchedulingQuery(params.query)),
  );
  const lookupQuery = buildCronMutationLookupQuery(params.query);

  if (!params.runtimeOps?.listCronJobs) {
    if (lastReference?.id && (wantsDirectReference || !lookupQuery)) {
      return {
        job: {
          id: lastReference.id,
          name: lastReference.name,
        },
      };
    }
    return {
      clarification: {
        text: "Saya belum bisa me-resolve job cron yang dimaksud di runtime ini.",
      },
    };
  }

  const page = await params.runtimeOps.listCronJobs({
    includeDisabled: true,
    enabled: "all",
    query: lookupQuery,
  });
  const jobs = page.jobs ?? [];

  if (lastReference?.id && (wantsDirectReference || !lookupQuery)) {
    const matchedLast = jobs.find((job) => job.id === lastReference.id);
    if (matchedLast) {
      return { job: matchedLast };
    }
    return {
      job: {
        id: lastReference.id,
        name: lastReference.name,
      },
    };
  }

  if (jobs.length === 1 && jobs[0]) {
    return { job: jobs[0] };
  }

  if (lastReference?.id) {
    const matchedLast = jobs.find((job) => job.id === lastReference.id);
    if (matchedLast) {
      return { job: matchedLast };
    }
  }

  if (jobs.length === 0) {
    return {
      clarification: {
        text: "Saya tidak menemukan job cron yang cocok untuk diubah. Sebutkan nama job-nya atau rujuk job terakhir secara lebih spesifik.",
      },
    };
  }

  return {
    clarification: {
      text: "Saya menemukan lebih dari satu job yang mungkin cocok. Sebutkan nama job-nya atau rujuk job terakhir dengan lebih spesifik.",
    },
  };
}

async function buildCronUpdateAction(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  rawQuery: string;
  normalizedQuery: string;
  sessionEntry?: SessionEntry;
  runtimeOps?: SchedulingRuntimeOps;
}): Promise<DeterministicSchedulingContext | undefined> {
  const resolvedJob = await resolveCronJobForMutation({
    query: params.rawQuery,
    sessionEntry: params.sessionEntry,
    runtimeOps: params.runtimeOps,
  });
  if ("clarification" in resolvedJob) {
    return {
      directReply: resolvedJob.clarification,
    };
  }

  const patch: Record<string, unknown> = {};
  const schedule = parseReminderSchedule(params.rawQuery);
  const resolvedSchedule = buildResolvedSchedule(schedule);
  if (resolvedSchedule) {
    patch.schedule = resolvedSchedule.schedule;
    patch.deleteAfterRun = resolvedSchedule.deleteAfterRun;
  }

  const pendingForDelivery = buildPendingSchedulingIntent({
    kind:
      resolvedJob.job.payload?.kind === "httpAction"
        ? "automation"
        : resolvedJob.job.schedule?.everyMs || resolvedJob.job.schedule?.expr
          ? "periodic_monitoring"
          : "reminder",
    rawRequest: params.rawQuery,
    normalizedRequest: params.normalizedQuery,
    schedule,
    recommendedExecutor: "cron",
    originatingRoute: resolveCurrentReturnRoute(params.ctx) ?? undefined,
    allowedDeliveryChoices: await buildAllowedDeliveryChoices({
      cfg: params.cfg,
      ctx: params.ctx,
    }),
  });
  const automationSlots =
    resolvedJob.job.payload?.kind === "httpAction"
      ? resolveAutomationUrlSlots(params.rawQuery)
      : undefined;
  const selection =
    resolvedJob.job.payload?.kind === "httpAction"
      ? await detectAutomationNotifyResolutionFromRuntime({
          cfg: params.cfg,
          query: params.normalizedQuery,
          rawQuery: params.rawQuery,
          pending: pendingForDelivery,
          ctx: params.ctx,
          actionUrl: automationSlots?.actionUrl,
        })
      : await detectDeliveryResolutionFromRuntime({
          cfg: params.cfg,
          query: params.normalizedQuery,
          pending: pendingForDelivery,
          ctx: params.ctx,
        });

  if (resolvedJob.job.payload?.kind !== "httpAction") {
    const deliveryConflict = await buildReminderDeliveryConflictReply({
      cfg: params.cfg,
      query: params.normalizedQuery,
      rawQuery: params.rawQuery,
      pending: pendingForDelivery,
      ctx: params.ctx,
    });
    if (deliveryConflict) {
      return {
        directReply: deliveryConflict,
      };
    }
  }

  if (resolvedJob.job.payload?.kind === "httpAction" && automationSlots?.actionUrl) {
    patch.payload = {
      kind: "httpAction",
      request: {
        url: automationSlots.actionUrl,
      },
    };
  }

  if (selection.kind !== "none") {
    const deliveryResult = await resolveDeliveryTargetDetails({
      selection,
      pending: pendingForDelivery,
      cfg: params.cfg,
      sessionKey: params.ctx.SessionKey ?? "main",
    });
    if ("clarification" in deliveryResult) {
      return {
        directReply: deliveryResult.clarification,
      };
    }
    patch.delivery = deliveryResult.delivery;
  }

  if (Object.keys(patch).length === 0) {
    return {
      directReply: {
        text: "Saya belum menangkap perubahan cron yang jelas. Sebutkan perubahan waktunya, target delivery, atau webhook barunya.",
      },
    };
  }

  return {
    directReply: {
      text: `Siap, saya akan memperbarui job ${resolvedJob.job.name ?? resolvedJob.job.id}.`,
    },
    resolvedSchedulingAction: {
      kind: "cron.update",
      params: {
        id: resolvedJob.job.id,
        patch,
      },
      confirmationText: `Siap, job ${resolvedJob.job.name ?? resolvedJob.job.id} sudah diperbarui.`,
      rememberJobId: resolvedJob.job.id,
    },
  };
}

async function buildCronRemoveAction(params: {
  rawQuery: string;
  sessionEntry?: SessionEntry;
  runtimeOps?: SchedulingRuntimeOps;
}): Promise<DeterministicSchedulingContext | undefined> {
  const resolvedJob = await resolveCronJobForMutation({
    query: params.rawQuery,
    sessionEntry: params.sessionEntry,
    runtimeOps: params.runtimeOps,
  });
  if ("clarification" in resolvedJob) {
    return {
      directReply: resolvedJob.clarification,
    };
  }
  return {
    directReply: {
      text: `Siap, saya akan menghapus job ${resolvedJob.job.name ?? resolvedJob.job.id}.`,
    },
    resolvedSchedulingAction: {
      kind: "cron.remove",
      params: {
        id: resolvedJob.job.id,
      },
      confirmationText: `Siap, job ${resolvedJob.job.name ?? resolvedJob.job.id} sudah dihapus.`,
      removedJobId: resolvedJob.job.id,
    },
  };
}

export async function resolvePendingSchedulingFollowup(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  query: string;
  sessionEntry?: SessionEntry;
  sessionKey: string;
}): Promise<DeterministicSchedulingContext | undefined> {
  const pending = params.sessionEntry?.pendingSchedulingIntent;
  if (!pending) {
    return undefined;
  }

  const normalizedFollowupQuery = normalizeSchedulingQuery(params.query);
  if (!normalizedFollowupQuery) {
    return undefined;
  }

  const combinedRawQuery = buildPendingContextQuery(pending, params.query);
  const combinedQuery = normalizeSchedulingQuery(combinedRawQuery);

  const automationSlots =
    pending.kind === "automation" ? resolveAutomationUrlSlots(combinedRawQuery) : undefined;
  const selection =
    pending.kind === "automation"
      ? await detectAutomationNotifyResolutionFromRuntime({
          cfg: params.cfg,
          query: combinedQuery,
          rawQuery: combinedRawQuery,
          pending,
          ctx: params.ctx,
          actionUrl: automationSlots?.actionUrl,
        })
      : await detectDeliveryResolutionFromRuntime({
          cfg: params.cfg,
          query: combinedQuery,
          pending,
          ctx: params.ctx,
        });

  if (pending.expiresAt <= Date.now()) {
    logVerbose("scheduling-intent: pending clarification expired");
    if (
      selection.kind !== "none" ||
      HEARTBEAT_SELECTION_RE.test(combinedQuery) ||
      CRON_SELECTION_RE.test(combinedQuery)
    ) {
      return {
        directReply: buildPendingExpiredReply(),
        clearPendingScheduling: true,
      };
    }
    return {
      clearPendingScheduling: true,
    };
  }
  if (selection.kind === "cancel") {
    logVerbose("scheduling-intent: pending clarification canceled");
    return {
      directReply: buildPendingCanceledReply(),
      clearPendingScheduling: true,
    };
  }

  let nextPending: PendingSchedulingIntent = pending;
  if (combinedRawQuery !== pending.rawRequest || combinedQuery !== pending.normalizedRequest) {
    nextPending = {
      ...nextPending,
      rawRequest: combinedRawQuery,
      normalizedRequest: combinedQuery,
    };
  }
  if (pending.schedule.mode === "unresolved") {
    const scheduleFollowup = parseReminderSchedule(combinedRawQuery);
    if (scheduleFollowup.mode !== "unresolved") {
      nextPending = {
        ...nextPending,
        rawRequest: combinedRawQuery,
        normalizedRequest: combinedQuery,
        schedule: scheduleFollowup,
      };
    }
  }
  if (pending.kind === "periodic_monitoring") {
    if (HEARTBEAT_SELECTION_RE.test(combinedQuery)) {
      nextPending = {
        ...nextPending,
        recommendedExecutor: "heartbeat",
      };
      logVerbose("scheduling-intent: follow-up selected heartbeat executor");
    } else if (CRON_SELECTION_RE.test(combinedQuery)) {
      nextPending = {
        ...nextPending,
        recommendedExecutor: "cron",
      };
      logVerbose("scheduling-intent: follow-up selected cron executor");
    }
  }

  if (!isSelectionAllowed(nextPending, selection)) {
    logVerbose(`scheduling-intent: selection ${selection.kind} is not allowed for pending state`);
    return {
      directReply: await buildDisallowedDeliveryReply({
        cfg: params.cfg,
        ctx: params.ctx,
        pending: nextPending,
      }),
      sessionPatch: {
        pendingSchedulingIntent: nextPending,
      },
    };
  }

  if (nextPending.kind !== "automation") {
    const deliveryConflict = await buildReminderDeliveryConflictReply({
      cfg: params.cfg,
      query: combinedQuery,
      rawQuery: combinedRawQuery,
      pending: nextPending,
      ctx: params.ctx,
    });
    if (deliveryConflict) {
      return {
        directReply: deliveryConflict,
        sessionPatch: {
          pendingSchedulingIntent: nextPending,
        },
      };
    }
  }

  if (selection.kind === "none") {
    if (nextPending.schedule.mode === "unresolved") {
      return {
        directReply: buildReminderModeClarification(nextPending.kind),
        sessionPatch: {
          pendingSchedulingIntent: nextPending,
        },
      };
    }
    if (nextPending !== pending) {
      return {
        directReply: await buildReminderClarification({
          cfg: params.cfg,
          ctx: params.ctx,
          query: nextPending.rawRequest,
          periodicMonitoring: nextPending.kind === "periodic_monitoring",
        }),
        sessionPatch: {
          pendingSchedulingIntent: nextPending,
        },
      };
    }
    return undefined;
  }

  logVerbose(`scheduling-intent: consuming pending clarification with selection ${selection.kind}`);
  const resolved: SchedulingActionBuildResult =
    nextPending.kind === "reminder"
      ? await buildReminderAction({
          pending: nextPending,
          selection,
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        })
      : nextPending.kind === "periodic_monitoring"
        ? await buildPeriodicAction({
            pending: nextPending,
            selection,
            cfg: params.cfg,
            sessionKey: params.sessionKey,
          })
        : await buildAutomationAction({
            pending: nextPending,
            selection,
            cfg: params.cfg,
            sessionKey: params.sessionKey,
          });
  if (!hasResolvedSchedulingAction(resolved)) {
    return {
      directReply: resolved.clarification,
      sessionPatch: {
        pendingSchedulingIntent: nextPending,
      },
    };
  }
  return {
    directReply: {
      text: resolved.action.confirmationText,
    },
    resolvedSchedulingAction: resolved.action,
    clearPendingScheduling: true,
  };
}

export async function buildDeterministicSchedulingContext(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  query: string;
  sessionEntry?: SessionEntry;
  runtimeOps?: SchedulingRuntimeOps;
}): Promise<DeterministicSchedulingContext | undefined> {
  const rawQuery = normalizeWhitespace(params.query);
  const query = normalizeSchedulingQuery(rawQuery);
  if (!rawQuery || !query) {
    return undefined;
  }

  if (looksLikeCronStatusQuery(rawQuery)) {
    return {
      resolvedSchedulingAction: {
        kind: "cron.status",
        params: {},
      },
    };
  }

  if (looksLikeCronListQuery(rawQuery)) {
    return {
      resolvedSchedulingAction: {
        kind: "cron.list",
        params: {
          enabled: /(?:\bsemua\b|\ball\b)/i.test(query) ? "all" : "enabled",
          query: buildCronListQuery(rawQuery),
        },
        rememberIfSingleResult: true,
      },
    };
  }

  if (looksLikeCronRemoveQuery(rawQuery)) {
    return await buildCronRemoveAction({
      rawQuery,
      sessionEntry: params.sessionEntry,
      runtimeOps: params.runtimeOps,
    });
  }

  if (looksLikeCronUpdateQuery(rawQuery)) {
    return await buildCronUpdateAction({
      cfg: params.cfg,
      ctx: params.ctx,
      rawQuery,
      normalizedQuery: query,
      sessionEntry: params.sessionEntry,
      runtimeOps: params.runtimeOps,
    });
  }

  if (looksLikeCliCapabilityQuery(rawQuery)) {
    return {
      directReply: buildCliCapabilityReply(params.cfg),
    };
  }

  if (looksLikeCronCapabilityQuery(rawQuery)) {
    return {
      directReply: await buildCronCapabilityReply(params),
    };
  }

  if (looksLikeHeartbeatCapabilityQuery(rawQuery)) {
    return {
      directReply: buildHeartbeatCapabilityReply(params.cfg),
    };
  }

  const schedule = parseReminderSchedule(rawQuery);
  const isReminder = looksLikeReminderIntent(query, schedule);
  const isAutomation = looksLikeAutomationIntent(query, schedule);
  const isPeriodic = looksLikePeriodicMonitoringIntent(query, schedule);
  if (!isPeriodic && !isReminder && !isAutomation) {
    return undefined;
  }

  const recommendedExecutor: PendingSchedulingIntent["recommendedExecutor"] = isPeriodic
    ? "heartbeat"
    : "cron";
  const allowedDeliveryChoices = await buildAllowedDeliveryChoices({
    cfg: params.cfg,
    ctx: params.ctx,
  });
  const pending = buildPendingSchedulingIntent({
    kind: isAutomation ? "automation" : isPeriodic ? "periodic_monitoring" : "reminder",
    rawRequest: rawQuery,
    normalizedRequest: query,
    schedule,
    recommendedExecutor,
    originatingRoute: resolveCurrentReturnRoute(params.ctx) ?? undefined,
    allowedDeliveryChoices,
  });

  if (schedule.mode === "unresolved") {
    logVerbose("scheduling-intent: schedule unresolved, storing pending clarification");
    return {
      directReply: buildReminderModeClarification(pending.kind),
      sessionPatch: {
        pendingSchedulingIntent: pending,
      },
    };
  }

  const automationSlots =
    pending.kind === "automation" ? resolveAutomationUrlSlots(rawQuery) : undefined;
  const selection =
    pending.kind === "automation"
      ? await detectAutomationNotifyResolutionFromRuntime({
          cfg: params.cfg,
          query,
          rawQuery,
          pending,
          ctx: params.ctx,
          actionUrl: automationSlots?.actionUrl,
        })
      : await detectDeliveryResolutionFromRuntime({
          cfg: params.cfg,
          query,
          pending,
          ctx: params.ctx,
        });
  if (pending.kind !== "automation") {
    const deliveryConflict = await buildReminderDeliveryConflictReply({
      cfg: params.cfg,
      query,
      rawQuery,
      pending,
      ctx: params.ctx,
    });
    if (deliveryConflict) {
      return {
        directReply: deliveryConflict,
        sessionPatch: {
          pendingSchedulingIntent: pending,
        },
      };
    }
  }
  if (selection.kind === "none") {
    logVerbose("scheduling-intent: created delivery clarification");
    if (pending.kind === "automation") {
      return {
        directReply: {
          text: "Automation butuh dua target yang berbeda: action webhook dan notify target. Saya sudah menangkap action-nya, tetapi saya masih perlu target notifikasi yang terpisah.",
        },
        sessionPatch: {
          pendingSchedulingIntent: pending,
        },
      };
    }
    return {
      directReply: await buildReminderClarification({
        cfg: params.cfg,
        ctx: params.ctx,
        query,
        periodicMonitoring: isPeriodic,
      }),
      sessionPatch: {
        pendingSchedulingIntent: pending,
      },
    };
  }

  if (!isSelectionAllowed(pending, selection)) {
    logVerbose(`scheduling-intent: first-turn selection ${selection.kind} is not allowed`);
    return {
      directReply: await buildDisallowedDeliveryReply({
        cfg: params.cfg,
        ctx: params.ctx,
        pending,
      }),
      sessionPatch: {
        pendingSchedulingIntent: pending,
      },
    };
  }

  const resolved: SchedulingActionBuildResult =
    pending.kind === "reminder"
      ? await buildReminderAction({
          pending,
          selection,
          cfg: params.cfg,
          sessionKey: params.ctx.SessionKey ?? "main",
        })
      : pending.kind === "periodic_monitoring"
        ? await buildPeriodicAction({
            pending,
            selection,
            cfg: params.cfg,
            sessionKey: params.ctx.SessionKey ?? "main",
          })
        : await buildAutomationAction({
            pending,
            selection,
            cfg: params.cfg,
            sessionKey: params.ctx.SessionKey ?? "main",
          });
  if (!hasResolvedSchedulingAction(resolved)) {
    return {
      directReply: resolved.clarification,
      sessionPatch: {
        pendingSchedulingIntent: pending,
      },
    };
  }
  return {
    directReply: {
      text: resolved.action.confirmationText,
    },
    resolvedSchedulingAction: resolved.action,
    clearPendingScheduling: true,
  };
}
