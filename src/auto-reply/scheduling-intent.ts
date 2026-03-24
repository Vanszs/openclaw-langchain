import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PendingSchedulingDeliveryChoice,
  PendingSchedulingIntent,
  PendingSchedulingRoute,
  SessionEntry,
} from "../config/sessions/types.js";
import { logVerbose } from "../globals.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import type { MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

const PENDING_SCHEDULING_TTL_MS = 15 * 60_000;
const CLI_CAPABILITY_QUERY_RE =
  /(?:\b(?:akses|access|pakai|use|run)\b.*\bcli\b)|(?:\bcli\b.*\b(?:bisa|can|tersedia|available|akses|access)\b)/i;
const CRON_CAPABILITY_QUERY_RE =
  /(?:\b(?:bisa|can|could|pakai|use|akses|access|available|tersedia)\b.*\bcron\b)|(?:\bcron\b.*\b(?:bisa|can|could|pakai|use|available|tersedia|jalan|working)\b)/i;
const HEARTBEAT_CAPABILITY_QUERY_RE =
  /(?:\b(?:heartbeat)\b.*\b(?:bisa|can|available|tersedia|aktif|enabled|pakai|use)\b)|(?:\b(?:bisa|can|available|tersedia|aktif|enabled|pakai|use)\b.*\bheartbeat\b)/i;
const REMINDER_INTENT_RE =
  /\b(remind(?: me)?|reminder|ingatkan|pengingat|buat\s+pengingat|set\s+reminder|jadwalkan|schedule|chat\s+saya\s+lagi|ping\s+saya|kasih\s+tahu\s+saya|tolong\s+ingetin)\b/i;
const PERIODIC_MONITORING_RE =
  /(?:\b(?:setiap|tiap|every)\b.*\b(?:menit|min(?:ute)?s?|jam|hour|hours?|hari|day|days)\b)|(?:\b(?:cek|check|monitor|pantau|review)\b.*\b(?:email|gmail|calendar|kalender|weather|cuaca|status)\b.*\b(?:setiap|tiap|every)\b)/i;
const SAME_CHAT_RE =
  /\b(chat\s+(?:ini|saja|aja)|balas\s+chat\s+saja|balas\s+chat|balas\s+ke\s+(?:sini|chat\s+ini)|ke\s+sini\s+aja|reply\s+here|back\s+here|yang\s+tadi\s+aja)\b/i;
const INTERNAL_RE =
  /\b(internal|simpan\s+internal|simpan\s+aja|simpan\s+internal\s+saja|jangan\s+kirim|tanpa\s+kirim|jangan\s+balas|no\s+delivery|don't\s+send|dont\s+send)\b/i;
const WEBHOOK_RE = /\bwebhook\b|https?:\/\//i;
const CANCEL_RE = /\b(batal|cancel|gak\s+jadi|ga\s+jadi|never\s+mind|abaikan)\b/i;
const HEARTBEAT_SELECTION_RE = /\bheartbeat\b/i;
const CRON_SELECTION_RE = /\bcron\b/i;
const EMAIL_OR_CALENDAR_RE = /\b(email|gmail|calendar|kalender)\b/i;
const RELATIVE_TIME_RE =
  /\b(?:(?:in)\s+)?(\d+(?:\.\d+)?)\s*(detik|seconds?|secs?|menit|minutes?|mins?|jam|hours?|hari|days?|ms|s|m|h|d)\b(?:\s+lagi)?/i;
const RECURRING_TIME_RE =
  /\b(?:setiap|tiap|every)\s+(\d+(?:\.\d+)?)\s*(detik|seconds?|secs?|menit|minutes?|mins?|jam|hours?|hari|days?|ms|s|m|h|d)\b/i;
const ABSOLUTE_TIME_RE =
  /\b(?:pada|jam|at)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[t\s][0-9:.+-zZ]+)?|[0-9]{10,13})\b/i;
const REMINDER_PREFIX_RE =
  /^(?:tolong\s+|please\s+)?(?:ingatkan(?:\s+saya)?|buat\s+pengingat|set\s+reminder|remind(?:\s+me)?|chat\s+saya\s+lagi|ping\s+saya|kasih\s+tahu\s+saya|tolong\s+ingetin)\b/i;
const CONNECTOR_PREFIX_RE = /^(?:untuk|buat|soal|bahwa|agar|supaya|to)\b\s*/i;
const TRIM_FILLER_RE = /\b(?:saja|aja|dong|please|tolong)\b/gi;
const SAME_CHANNEL_RE =
  /\b(balas\s+saja|yang\s+tadi|ke\s+yang\s+sama|channel\s+yang\s+sama|pakai\s+channel\s+yang\s+sama)\b/i;

export type DeterministicSchedulingAction = {
  kind: "cron.add";
  params: Record<string, unknown>;
  confirmationText: string;
};

export type DeterministicSchedulingContext = {
  directReply?: ReplyPayload;
  sessionPatch?: Partial<SessionEntry>;
  clearPendingScheduling?: boolean;
  resolvedSchedulingAction?: DeterministicSchedulingAction;
};

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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSchedulingQuery(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/[?!.,;:()[\]{}"']/g, " ")
      .replace(/\bmemakai\b/g, "pakai")
      .replace(/\bgoogle\s*calendar\b/g, "calendar")
      .replace(/\bgoogle\s*chat\b/g, "googlechat"),
  );
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

function stripSchedulePhrases(value: string): string {
  return normalizeWhitespace(
    value
      .replace(REMINDER_PREFIX_RE, " ")
      .replace(RECURRING_TIME_RE, " ")
      .replace(RELATIVE_TIME_RE, " ")
      .replace(ABSOLUTE_TIME_RE, " ")
      .replace(CONNECTOR_PREFIX_RE, " ")
      .replace(TRIM_FILLER_RE, " "),
  );
}

function buildReminderText(query: string): string {
  const subject = stripSchedulePhrases(query).replace(/\s+/g, " ").trim();
  if (!subject) {
    return "Ini pengingat Anda.";
  }
  if (/^[a-z0-9-]+$/i.test(subject) && subject.split(" ").length <= 3) {
    return `Waktunya ${subject}!`;
  }
  return `Pengingat: ${subject}`;
}

function buildJobName(kind: "reminder" | "periodic_monitoring", query: string): string {
  const base = stripSchedulePhrases(query) || (kind === "reminder" ? "Reminder" : "Monitoring");
  const label = base.length > 40 ? `${base.slice(0, 39)}…` : base;
  return kind === "reminder" ? `Reminder: ${label}` : `Monitoring: ${label}`;
}

function parseReminderSchedule(query: string): ReminderSchedule {
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
    const parsed = Date.parse(absoluteMatch[1]);
    if (Number.isFinite(parsed) && parsed > Date.now()) {
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

function detectDeliveryResolution(query: string): DeliveryResolution {
  if (CANCEL_RE.test(query)) {
    return { kind: "cancel" };
  }
  if (SAME_CHAT_RE.test(query) || SAME_CHANNEL_RE.test(query)) {
    return { kind: "same_chat" };
  }
  if (INTERNAL_RE.test(query)) {
    return { kind: "internal" };
  }
  if (WEBHOOK_RE.test(query)) {
    const targetUrl = query.match(/https?:\/\/\S+/i)?.[0];
    return { kind: "webhook", targetUrl };
  }
  return { kind: "none" };
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
  if (currentRoute) {
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
  pending?: PendingSchedulingIntent;
  ctx?: MsgContext;
}): Promise<DeliveryResolution> {
  const direct = detectDeliveryResolution(params.query);
  if (direct.kind === "same_chat") {
    const channel = await resolveConfiguredChannelSelection(params);
    if (channel) {
      return {
        kind: "channel",
        channel,
      };
    }
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
  const channel = normalizeMessageChannel(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  const to = ctx.OriginatingTo ?? ctx.To ?? ctx.From;
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return null;
  }
  return {
    channel,
    to,
    accountId: ctx.AccountId,
    threadId: ctx.MessageThreadId,
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
  if (currentRoute) {
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
  if (resolveCurrentReturnRoute(params.ctx)) {
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
  const capabilityLine = EMAIL_OR_CALENDAR_RE.test(params.query)
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
  const capabilityLine = EMAIL_OR_CALENDAR_RE.test(params.query)
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

async function resolveNamedChannelTarget(params: {
  selection: Extract<DeliveryResolution, { kind: "channel" }>;
  pending: PendingSchedulingIntent;
  cfg: OpenClawConfig;
}): Promise<{ channel: string; to: string; accountId?: string } | { clarification: ReplyPayload }> {
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
      channel: params.selection.channel,
      to: route.to,
      accountId: route.accountId,
    };
  }
  return {
    clarification: {
      text: `Saya bisa memakai ${formatChannelLabel(params.selection.channel)}, tetapi saya masih perlu target ${formatChannelLabel(params.selection.channel)}-nya.`,
    },
  };
}

async function buildReminderAction(params: {
  pending: PendingSchedulingIntent;
  selection: DeliveryResolution;
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<{ action: DeterministicSchedulingAction } | { clarification: ReplyPayload }> {
  const reminderText = buildReminderText(params.pending.normalizedRequest);
  const name = buildJobName("reminder", params.pending.normalizedRequest);
  const schedule =
    params.pending.schedule.mode === "relative"
      ? {
          kind: "at" as const,
          at: new Date(Date.now() + params.pending.schedule.delayMs).toISOString(),
        }
      : params.pending.schedule.mode === "absolute"
        ? { kind: "at" as const, at: params.pending.schedule.at }
        : null;
  if (!schedule) {
    return {
      clarification: {
        text: "Saya masih perlu waktu pengingat yang jelas dulu, misalnya 1 menit lagi atau 2 jam lagi.",
      },
    };
  }

  if (params.selection.kind === "same_chat") {
    const route = params.pending.originatingRoute;
    if (!route?.channel || !route.to) {
      return {
        clarification: {
          text: "Saya belum punya route chat yang bisa dipakai. Sebutkan channel atau targetnya dulu.",
        },
      };
    }
    return {
      action: {
        kind: "cron.add",
        confirmationText: `Siap, saya akan mengingatkan kembali di chat ini dalam ${formatDurationText(params.pending.schedule.mode === "relative" ? params.pending.schedule.delayMs : Math.max(1, Date.parse(schedule.at) - Date.now()))}.`,
        params: {
          name,
          schedule,
          sessionTarget: "current",
          sessionKey: params.sessionKey,
          deleteAfterRun: true,
          payload: {
            kind: "agentTurn",
            message: buildReminderPrompt(reminderText),
            thinking: "off",
            lightContext: true,
            timeoutSeconds: 30,
          },
          delivery: {
            mode: "announce",
            channel: route.channel,
            to: route.to,
            accountId: route.accountId,
          },
        },
      },
    };
  }

  if (params.selection.kind === "internal") {
    return {
      action: {
        kind: "cron.add",
        confirmationText: `Siap, saya sudah menjadwalkan pengingat internal dalam ${formatDurationText(params.pending.schedule.mode === "relative" ? params.pending.schedule.delayMs : Math.max(1, Date.parse(schedule.at) - Date.now()))}.`,
        params: {
          name,
          schedule,
          sessionTarget: "current",
          sessionKey: params.sessionKey,
          deleteAfterRun: true,
          payload: {
            kind: "agentTurn",
            message: buildReminderPrompt(reminderText),
            thinking: "off",
            lightContext: true,
            timeoutSeconds: 30,
          },
          delivery: {
            mode: "none",
          },
        },
      },
    };
  }

  if (params.selection.kind === "channel") {
    const resolved = await resolveNamedChannelTarget({
      selection: params.selection,
      pending: params.pending,
      cfg: params.cfg,
    });
    if ("clarification" in resolved) {
      return resolved;
    }
    return {
      action: {
        kind: "cron.add",
        confirmationText: `Siap, saya akan mengirim pengingat lewat ${resolved.channel} dalam ${formatDurationText(params.pending.schedule.mode === "relative" ? params.pending.schedule.delayMs : Math.max(1, Date.parse(schedule.at) - Date.now()))}.`,
        params: {
          name,
          schedule,
          sessionTarget: "current",
          sessionKey: params.sessionKey,
          deleteAfterRun: true,
          payload: {
            kind: "agentTurn",
            message: buildReminderPrompt(reminderText),
            thinking: "off",
            lightContext: true,
            timeoutSeconds: 30,
          },
          delivery: {
            mode: "announce",
            channel: resolved.channel,
            to: resolved.to,
            accountId: resolved.accountId,
          },
        },
      },
    };
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
          text: "Saya perlu URL webhook-nya dulu untuk target reminder itu.",
        },
      };
    }
    return {
      action: {
        kind: "cron.add",
        confirmationText: `Siap, saya sudah menjadwalkan callback webhook dalam ${formatDurationText(params.pending.schedule.mode === "relative" ? params.pending.schedule.delayMs : Math.max(1, Date.parse(schedule.at) - Date.now()))}.`,
        params: {
          name,
          schedule,
          sessionTarget: "current",
          sessionKey: params.sessionKey,
          deleteAfterRun: true,
          payload: {
            kind: "agentTurn",
            message: buildReminderPrompt(reminderText),
            thinking: "off",
            lightContext: true,
            timeoutSeconds: 30,
          },
          delivery: {
            mode: "webhook",
            to: targetUrl,
          },
        },
      },
    };
  }

  return {
    clarification: {
      text: "Saya masih perlu target pengingatnya terlebih dulu.",
    },
  };
}

async function buildPeriodicAction(params: {
  pending: PendingSchedulingIntent;
  selection: DeliveryResolution;
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<{ action: DeterministicSchedulingAction } | { clarification: ReplyPayload }> {
  const schedule = params.pending.schedule;
  if (schedule.mode !== "recurring") {
    return {
      clarification: {
        text: "Untuk monitoring berkala, saya masih perlu interval yang jelas dulu, misalnya tiap 30 menit.",
      },
    };
  }

  const monitoringText = buildMonitoringPrompt(params.pending.rawRequest);
  const name = buildJobName("periodic_monitoring", params.pending.normalizedRequest);

  if (params.selection.kind === "internal") {
    if (params.pending.recommendedExecutor === "heartbeat") {
      return {
        action: {
          kind: "cron.add",
          confirmationText: `Siap, saya akan memantau tiap ${formatDurationText(schedule.everyMs)} secara internal lewat heartbeat.`,
          params: {
            name,
            schedule: { kind: "every", everyMs: schedule.everyMs },
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
        confirmationText: `Siap, saya akan memantau tiap ${formatDurationText(schedule.everyMs)} secara internal lewat cron.`,
        params: {
          name,
          schedule: { kind: "every", everyMs: schedule.everyMs },
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

  if (params.selection.kind === "same_chat") {
    const route = params.pending.originatingRoute;
    if (!route?.channel || !route.to) {
      return {
        clarification: {
          text: "Saya belum punya route chat yang bisa dipakai. Sebutkan channel atau targetnya dulu.",
        },
      };
    }
    return {
      action: {
        kind: "cron.add",
        confirmationText: `Siap, saya akan memantau tiap ${formatDurationText(schedule.everyMs)} dan membalas lewat chat ini.`,
        params: {
          name,
          schedule: { kind: "every", everyMs: schedule.everyMs },
          sessionTarget: "current",
          sessionKey: params.sessionKey,
          payload: {
            kind: "agentTurn",
            message: monitoringText,
            lightContext: true,
            timeoutSeconds: 60,
          },
          delivery: {
            mode: "announce",
            channel: route.channel,
            to: route.to,
            accountId: route.accountId,
          },
        },
      },
    };
  }

  if (params.selection.kind === "channel") {
    const resolved = await resolveNamedChannelTarget({
      selection: params.selection,
      pending: params.pending,
      cfg: params.cfg,
    });
    if ("clarification" in resolved) {
      return resolved;
    }
    return {
      action: {
        kind: "cron.add",
        confirmationText: `Siap, saya akan memantau tiap ${formatDurationText(schedule.everyMs)} dan mengirim hasil lewat ${resolved.channel}.`,
        params: {
          name,
          schedule: { kind: "every", everyMs: schedule.everyMs },
          sessionTarget: "current",
          sessionKey: params.sessionKey,
          payload: {
            kind: "agentTurn",
            message: monitoringText,
            lightContext: true,
            timeoutSeconds: 60,
          },
          delivery: {
            mode: "announce",
            channel: resolved.channel,
            to: resolved.to,
            accountId: resolved.accountId,
          },
        },
      },
    };
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
          text: "Saya perlu URL webhook-nya dulu untuk target monitoring itu.",
        },
      };
    }
    return {
      action: {
        kind: "cron.add",
        confirmationText: `Siap, saya akan memantau tiap ${formatDurationText(schedule.everyMs)} dan mengirim hasil lewat webhook.`,
        params: {
          name,
          schedule: { kind: "every", everyMs: schedule.everyMs },
          sessionTarget: "current",
          sessionKey: params.sessionKey,
          payload: {
            kind: "agentTurn",
            message: monitoringText,
            lightContext: true,
            timeoutSeconds: 60,
          },
          delivery: {
            mode: "webhook",
            to: targetUrl,
          },
        },
      },
    };
  }

  return {
    clarification: {
      text: "Saya masih perlu target monitoringnya terlebih dulu.",
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

  const query = normalizeSchedulingQuery(params.query);
  if (!query) {
    return undefined;
  }

  const selection = await detectDeliveryResolutionFromRuntime({
    cfg: params.cfg,
    query,
    pending,
    ctx: params.ctx,
  });

  if (pending.expiresAt <= Date.now()) {
    logVerbose("scheduling-intent: pending clarification expired");
    if (
      selection.kind !== "none" ||
      HEARTBEAT_SELECTION_RE.test(query) ||
      CRON_SELECTION_RE.test(query)
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

  let nextPending = pending;
  if (pending.kind === "periodic_monitoring") {
    if (HEARTBEAT_SELECTION_RE.test(query)) {
      nextPending = {
        ...pending,
        recommendedExecutor: "heartbeat",
      };
      logVerbose("scheduling-intent: follow-up selected heartbeat executor");
    } else if (CRON_SELECTION_RE.test(query)) {
      nextPending = {
        ...pending,
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

  if (selection.kind === "none") {
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
  const resolved =
    nextPending.kind === "reminder"
      ? await buildReminderAction({
          pending: nextPending,
          selection,
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        })
      : await buildPeriodicAction({
          pending: nextPending,
          selection,
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        });
  if ("clarification" in resolved) {
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
}): Promise<DeterministicSchedulingContext | undefined> {
  const query = normalizeSchedulingQuery(params.query);
  if (!query) {
    return undefined;
  }

  if (CLI_CAPABILITY_QUERY_RE.test(query)) {
    return {
      directReply: buildCliCapabilityReply(params.cfg),
    };
  }

  if (CRON_CAPABILITY_QUERY_RE.test(query)) {
    return {
      directReply: await buildCronCapabilityReply(params),
    };
  }

  if (HEARTBEAT_CAPABILITY_QUERY_RE.test(query)) {
    return {
      directReply: buildHeartbeatCapabilityReply(params.cfg),
    };
  }

  const isPeriodic = PERIODIC_MONITORING_RE.test(query);
  const isReminder = REMINDER_INTENT_RE.test(query);
  if (!isPeriodic && !isReminder) {
    return undefined;
  }

  const schedule = parseReminderSchedule(query);
  const recommendedExecutor: PendingSchedulingIntent["recommendedExecutor"] = isPeriodic
    ? "heartbeat"
    : "cron";
  const allowedDeliveryChoices = await buildAllowedDeliveryChoices({
    cfg: params.cfg,
    ctx: params.ctx,
  });
  const pending = buildPendingSchedulingIntent({
    kind: isPeriodic ? "periodic_monitoring" : "reminder",
    rawRequest: params.query,
    normalizedRequest: query,
    schedule,
    recommendedExecutor,
    originatingRoute: resolveCurrentReturnRoute(params.ctx) ?? undefined,
    allowedDeliveryChoices,
  });

  if (schedule.mode === "unresolved") {
    logVerbose("scheduling-intent: schedule unresolved, storing pending clarification");
    return {
      directReply: {
        text:
          pending.kind === "periodic_monitoring"
            ? "Saya masih perlu interval monitoring yang jelas dulu, misalnya tiap 30 menit."
            : "Saya masih perlu waktu pengingat yang jelas dulu, misalnya 1 menit lagi atau 2 jam lagi.",
      },
      sessionPatch: {
        pendingSchedulingIntent: pending,
      },
    };
  }

  const selection = await detectDeliveryResolutionFromRuntime({
    cfg: params.cfg,
    query,
    pending,
    ctx: params.ctx,
  });
  if (selection.kind === "none") {
    logVerbose("scheduling-intent: created delivery clarification");
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

  const resolved =
    pending.kind === "reminder"
      ? await buildReminderAction({
          pending,
          selection,
          cfg: params.cfg,
          sessionKey: params.ctx.SessionKey ?? "main",
        })
      : await buildPeriodicAction({
          pending,
          selection,
          cfg: params.cfg,
          sessionKey: params.ctx.SessionKey ?? "main",
        });
  if ("clarification" in resolved) {
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
