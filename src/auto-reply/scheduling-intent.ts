import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import type { MsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

const CLI_CAPABILITY_QUERY_RE =
  /(?:\b(?:akses|access|pakai|use|run)\b.*\bcli\b)|(?:\bcli\b.*\b(?:bisa|can|tersedia|available|akses|access)\b)/i;
const CRON_CAPABILITY_QUERY_RE =
  /(?:\b(?:bisa|can|could|pakai|use|akses|access|available|tersedia)\b.*\bcron\b)|(?:\bcron\b.*\b(?:bisa|can|could|pakai|use|available|tersedia|jalan|working)\b)/i;
const REMINDER_INTENT_RE =
  /\b(remind(?: me)?|reminder|ingatkan|pengingat|buat\s+pengingat|set\s+reminder|jadwalkan|schedule|gunakan\s+cron|pakai\s+cron)\b/i;
const PERIODIC_MONITORING_RE =
  /(?:\b(?:setiap|tiap|every)\b.*\b(?:menit|min(?:ute)?s?|jam|hour|hours?|hari|day|days)\b.*\b(?:cek|check|monitor|pantau|review|email|gmail|calendar|kalender|weather|cuaca|status)\b)|(?:\b(?:cek|check|monitor|pantau|review)\b.*\b(?:email|gmail|calendar|kalender|weather|cuaca|status)\b.*\b(?:setiap|tiap|every)\b.*\b(?:menit|min(?:ute)?s?|jam|hour|hours?|hari|day|days)\b)/i;
const EXPLICIT_SAME_CHAT_RE =
  /\b(chat\s+ini|di\s+sini|disini|balas\s+ke\s+sini|reply\s+here|back\s+here)\b/i;
const EXPLICIT_INTERNAL_RE =
  /\b(internal|jangan\s+kirim|tanpa\s+kirim|jangan\s+balas|no\s+delivery|don't\s+send|dont\s+send)\b/i;
const EXPLICIT_WEBHOOK_RE = /\bwebhook\b|https?:\/\//i;
const DELIVERY_CHANNEL_RE =
  /\b(telegram|whatsapp|discord|slack|signal|matrix|googlechat|irc|imessage|sms)\b/i;
const EMAIL_OR_CALENDAR_RE = /\b(email|gmail|calendar|kalender)\b/i;

export type DeterministicSchedulingContext = {
  directReply: ReplyPayload;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasExplicitDeliveryIntent(query: string): boolean {
  return (
    EXPLICIT_SAME_CHAT_RE.test(query) ||
    EXPLICIT_INTERNAL_RE.test(query) ||
    EXPLICIT_WEBHOOK_RE.test(query) ||
    DELIVERY_CHANNEL_RE.test(query)
  );
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

function resolveCurrentReturnRoute(ctx: MsgContext): { channel: string; to: string } | null {
  const channel = normalizeMessageChannel(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  const to = ctx.OriginatingTo ?? ctx.To ?? ctx.From;
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return null;
  }
  return {
    channel,
    to,
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

export async function buildDeterministicSchedulingContext(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  query: string;
}): Promise<DeterministicSchedulingContext | undefined> {
  const query = normalizeWhitespace(params.query);
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

  if (PERIODIC_MONITORING_RE.test(query)) {
    return {
      directReply: await buildReminderClarification({
        ...params,
        periodicMonitoring: true,
      }),
    };
  }

  if (REMINDER_INTENT_RE.test(query) && !hasExplicitDeliveryIntent(query)) {
    return {
      directReply: await buildReminderClarification(params),
    };
  }

  return undefined;
}
