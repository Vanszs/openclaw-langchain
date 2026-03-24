import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock, listConfiguredMessageChannelsMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  listConfiguredMessageChannelsMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  listConfiguredMessageChannels: listConfiguredMessageChannelsMock,
}));

import { buildDeterministicSchedulingContext } from "./scheduling-intent.js";
import { resolvePendingSchedulingFollowup } from "./scheduling-intent.js";

describe("buildDeterministicSchedulingContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnSyncMock.mockReturnValue({ status: 0 });
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram"]);
  });

  it("answers CLI capability from runtime facts", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query: "anda bisa akses cli?",
    });

    expect(result?.directReply.text).toBe(
      "Saya bisa menjalankan perintah shell. CLI OpenClaw tersedia di runtime ini. Cron juga tersedia.",
    );
  });

  it("clarifies ambiguous reminders using the current chat route", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query: "ingatkan saya 2 menit lagi untuk makan",
    });

    expect(result?.directReply.text).toContain("balas kembali ke chat ini");
    expect(result?.directReply.text).toContain("kirim ke webhook");
    expect(result?.directReply.text).toContain("simpan internal saja");
    expect(result?.sessionPatch?.pendingSchedulingIntent?.kind).toBe("reminder");
  });

  it("routes periodic monitoring toward heartbeat clarification", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        Surface: "webchat",
        SessionKey: "main",
      },
      query: "cek email dan kalender tiap 30 menit",
    });

    expect(result?.directReply.text).toContain("lebih cocok sebagai heartbeat");
    expect(result?.directReply.text).toContain(
      "Email atau calendar langsung belum menjadi target cron bawaan saat ini.",
    );
  });

  it("answers cron capability without pretending email or calendar are native targets", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram", "whatsapp"]);

    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query: "bisa pakai cron untuk kirim pengingat lewat email?",
    });

    expect(result?.directReply.text).toContain("cron tersedia");
    expect(result?.directReply.text).toContain("telegram, whatsapp");
    expect(result?.directReply.text).toContain(
      "Email atau calendar langsung belum menjadi target cron bawaan saat ini.",
    );
  });

  it("returns undefined when reminder delivery is already explicit", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query: "ingatkan saya 2 menit lagi dan balas ke chat ini",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.clearPendingScheduling).toBe(true);
  });

  it("consumes pending reminder follow-up for same chat delivery", async () => {
    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
      },
      sessionKey: "agent:main:telegram:direct:12345",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk makan",
          normalizedRequest: "ingatkan 1 menit lagi untuk makan",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          originatingRoute: {
            channel: "telegram",
            to: "12345",
          },
          allowedDeliveryChoices: ["same_chat", "configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "balas chat saja",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "12345",
    });
    expect(result?.directReply?.text).toContain("di chat ini");
  });

  it("expires stale pending reminder follow-ups", async () => {
    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {},
      sessionKey: "main",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi",
          normalizedRequest: "ingatkan 1 menit lagi",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          allowedDeliveryChoices: ["same_chat", "configured_channel", "webhook", "internal"],
          createdAt: Date.now() - 20 * 60_000,
          expiresAt: Date.now() - 1,
        },
      },
      query: "balas chat saja",
    });

    expect(result?.clearPendingScheduling).toBe(true);
    expect(result?.directReply?.text).toContain("kedaluwarsa");
  });
});
