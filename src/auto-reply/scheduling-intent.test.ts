import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  spawnSyncMock,
  listConfiguredMessageChannelsMock,
  resolveCronDeliveryTargetMock,
  loadSessionStoreMock,
  resolveStorePathMock,
  readChannelAllowFromStoreSyncMock,
} = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  listConfiguredMessageChannelsMock: vi.fn(),
  resolveCronDeliveryTargetMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
  readChannelAllowFromStoreSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

vi.mock("../infra/outbound/channel-selection.js", () => ({
  listConfiguredMessageChannels: listConfiguredMessageChannelsMock,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: loadSessionStoreMock,
  resolveStorePath: resolveStorePathMock,
}));

vi.mock("../cron/isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: resolveCronDeliveryTargetMock,
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStoreSync: readChannelAllowFromStoreSyncMock,
}));

import { buildDeterministicSchedulingContext } from "./scheduling-intent.js";
import { resolvePendingSchedulingFollowup } from "./scheduling-intent.js";

describe("buildDeterministicSchedulingContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnSyncMock.mockReturnValue({ status: 0 });
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram"]);
    loadSessionStoreMock.mockReturnValue({});
    resolveStorePathMock.mockReturnValue("/tmp/test-sessions.json");
    readChannelAllowFromStoreSyncMock.mockReturnValue([]);
    resolveCronDeliveryTargetMock.mockImplementation(async (_cfg, _agentId, params) => {
      if (!params.channel || params.channel === "last") {
        return {
          ok: false,
          channel: "telegram",
          mode: "implicit",
          error: new Error("missing target"),
        };
      }
      if (params.to == null) {
        return {
          ok: false,
          channel: params.channel,
          mode: "implicit",
          error: new Error("missing target"),
        };
      }
      return {
        ok: true,
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        threadId: params.threadId,
        replyToId: params.replyToId,
        mode: "explicit",
      };
    });
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

  it("does not offer same-chat when the current route channel is unavailable", async () => {
    resolveCronDeliveryTargetMock.mockResolvedValue({
      ok: false,
      channel: "googlechat",
      mode: "explicit",
      error: new Error("Unsupported channel: googlechat"),
    });

    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "googlechat",
        OriginatingTo: "spaces/aaa",
        ReplyToId: "spaces/aaa/threads/bbb",
        SessionKey: "agent:main:googlechat:group:spaces/aaa:thread:spaces/aaa/threads/bbb",
      },
      query: "ingatkan saya 2 menit lagi untuk deploy",
    });

    expect(result?.directReply.text).not.toContain("balas kembali ke chat ini");
    expect(result?.sessionPatch?.pendingSchedulingIntent?.allowedDeliveryChoices).toEqual([
      "configured_channel",
      "webhook",
      "internal",
    ]);
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

  it("keeps same-chat reminders on the live webchat session route", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        Surface: "webchat",
        SessionKey: "main",
      },
      query: "ingatkan saya 2 menit lagi dan balas ke chat ini",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "announce",
      channel: "webchat",
      to: "main",
    });
    expect(result?.clearPendingScheduling).toBe(true);
  });

  it("keeps explicit webhook URLs intact when parsing reminder targets", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query: "ingatkan saya 2 menit lagi via webhook https://example.com/hook",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "webhook",
      to: "https://example.com/hook",
    });
  });

  it("keeps ISO timestamps intact when parsing reminder schedules", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query: "ingatkan saya 2099-03-26T10:00:00Z dan balas ke chat ini",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.schedule).toEqual({
      kind: "at",
      at: "2099-03-26T10:00:00.000Z",
    });
  });

  it("parses natural clock time and recurring reminders deterministically", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query: "ingatkan saya besok jam 7 pagi dan balas ke chat ini",
    });
    const recurring = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query: "ingatkan saya setiap hari jam 2 malam untuk minum obat dan balas ke chat ini",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.schedule.kind).toBe("at");
    expect(recurring?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(recurring?.resolvedSchedulingAction?.params.schedule).toEqual({
      kind: "cron",
      expr: "0 2 * * *",
    });
  });

  it("keeps bare daily reminders on the reminder clarification path", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        Surface: "webchat",
        SessionKey: "main",
      },
      query: "ingatkan saya setiap hari untuk minum obat",
    });

    expect(result?.resolvedSchedulingAction).toBeUndefined();
    expect(result?.directReply?.text).toContain("waktu pengingat yang jelas");
    expect(result?.sessionPatch?.pendingSchedulingIntent?.kind).toBe("reminder");
    expect(result?.sessionPatch?.pendingSchedulingIntent?.schedule.mode).toBe("unresolved");
  });

  it("keeps reminder paraphrases on the deterministic reminder path without per-sentence regexes", async () => {
    const reminderQueries = [
      "kabari saya 10 menit lagi soal deploy dan balas ke chat ini",
      "ping saya besok jam 7 pagi untuk standup dan balas ke chat ini",
      "chat saya lagi setiap hari jam 2 malam buat minum obat dan balas ke chat ini",
    ];

    const results = await Promise.all(
      reminderQueries.map((query) =>
        buildDeterministicSchedulingContext({
          cfg: { cron: { enabled: true } },
          ctx: {
            OriginatingChannel: "telegram",
            OriginatingTo: "12345",
            SessionKey: "agent:main:telegram:direct:12345",
          },
          query,
        }),
      ),
    );

    for (const result of results) {
      expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
      expect(result?.clearPendingScheduling).toBe(true);
      expect(result?.resolvedSchedulingAction?.params.payload).toMatchObject({
        kind: "agentTurn",
      });
    }
    expect(results[0]?.resolvedSchedulingAction?.params.schedule).toMatchObject({
      kind: "at",
    });
    expect(results[1]?.resolvedSchedulingAction?.params.schedule).toMatchObject({
      kind: "at",
    });
    expect(results[2]?.resolvedSchedulingAction?.params.schedule).toEqual({
      kind: "cron",
      expr: "0 2 * * *",
    });
  });

  it("handles broader English reminder phrasing through the same deterministic path", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query: "remind me in 2 minutes to deploy and reply here",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.name).toBe("Reminder: deploy");
    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "12345",
    });
  });

  it("handles broader schedule list phrasing without requiring exact cron wording", async () => {
    const runtimeOps = {
      listCronJobs: vi.fn().mockResolvedValue({
        total: 1,
        jobs: [
          {
            id: "job-1",
            name: "Reminder: deploy",
            enabled: true,
            schedule: { kind: "cron", expr: "0 7 * * *" },
            delivery: { mode: "announce", channel: "telegram", to: "12345" },
          },
        ],
      }),
    };

    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query: "please show me all active schedules right now",
      runtimeOps,
    });

    expect(result?.resolvedSchedulingAction).toEqual({
      kind: "cron.list",
      params: {
        enabled: "all",
        query: undefined,
      },
      rememberIfSingleResult: true,
    });
  });

  it("keeps reminder text clean and preserves thread/reply routing for same-chat reminders", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram", "googlechat"]);

    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "googlechat",
        OriginatingTo: "spaces/AAA",
        ReplyToId: "spaces/AAA/threads/BBB",
        SessionKey: "agent:main:googlechat:direct:spaces/AAA",
      },
      query: "ingatkan saya 2 menit lagi untuk deploy lalu balas ke chat ini",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.delivery).toMatchObject({
      mode: "announce",
      channel: "googlechat",
      to: "spaces/AAA",
      replyToId: "spaces/AAA/threads/BBB",
    });
    expect(result?.resolvedSchedulingAction?.params.payload.message).toContain("Waktunya deploy!");
    expect(result?.resolvedSchedulingAction?.params.payload.message).not.toContain(
      "balas ke chat ini",
    );
  });

  it("strips same-chat follow-up wording variants from reminder payloads", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        Surface: "webchat",
        SessionKey: "agent:main:webchat:payload-clean",
      },
      query: "ingatkan saya 10 menit lagi dan balas kembali ke chat ini",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.payload.message).toContain(
      "Ini pengingat Anda.",
    );
    expect(result?.resolvedSchedulingAction?.params.payload.message).not.toContain(
      "balas kembali ke",
    );
  });

  it("strips leftover time and connector words from reminder payloads", async () => {
    const isoResult = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query:
        "ingatkan saya pada 2099-03-25T17:00:00Z untuk meeting via webhook https://example.com/iso",
    });
    const paraphraseResult = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query: "chat saya 1 menit lagi untuk saya makan via webhook https://example.com/hook",
    });

    expect(isoResult?.resolvedSchedulingAction?.params.payload.message).toContain(
      "Waktunya meeting!",
    );
    expect(isoResult?.resolvedSchedulingAction?.params.payload.message).not.toContain("pada");
    expect(paraphraseResult?.resolvedSchedulingAction?.params.payload.message).toContain(
      "Waktunya makan!",
    );
    expect(paraphraseResult?.resolvedSchedulingAction?.params.payload.message).not.toContain(
      "untuk saya",
    );
  });

  it("keeps delivery-only internal phrasing out of reminder content", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query: "ingatkan saya 2 menit lagi dan simpan internal saja",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.name).toBe("Reminder");
    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "none",
    });
    expect(result?.resolvedSchedulingAction?.params.payload.message).toContain(
      "Ini pengingat Anda.",
    );
    expect(result?.resolvedSchedulingAction?.params.payload.message).not.toContain("simpan");
  });

  it("preserves originating thread/topic routing for same-chat reminders", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        MessageThreadId: 42,
        SessionKey: "agent:main:telegram:group:12345:thread:42",
      },
      query: "ingatkan saya 2 menit lagi untuk deploy lalu balas ke chat ini",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "12345",
      threadId: 42,
    });
  });

  it("rehydrates same-chat thread routing from external session keys on internal gateway turns", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram", "googlechat"]);

    const telegramResult = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: "agent:main:telegram:group:12345:thread:42",
        SessionKey: "agent:main:telegram:group:12345:thread:42",
      },
      query: "ingatkan saya 2 menit lagi untuk deploy lalu balas ke chat ini",
    });
    const googleChatResult = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: "agent:main:googlechat:group:spaces/AAA:thread:spaces/AAA/threads/BBB",
        SessionKey: "agent:main:googlechat:group:spaces/AAA:thread:spaces/AAA/threads/BBB",
      },
      query: "ingatkan saya 2 menit lagi untuk deploy lalu balas ke chat ini",
    });

    expect(telegramResult?.resolvedSchedulingAction?.params.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "12345",
      threadId: "42",
    });
    expect(googleChatResult?.resolvedSchedulingAction?.params.delivery).toMatchObject({
      mode: "announce",
      channel: "googlechat",
      to: "spaces/aaa",
      threadId: "spaces/AAA/threads/BBB",
    });
  });

  it("routes conversational cron list, update, and remove requests deterministically", async () => {
    const runtimeOps = {
      listCronJobs: vi
        .fn()
        .mockResolvedValueOnce({
          total: 1,
          jobs: [
            {
              id: "job-1",
              name: "Reminder: deploy",
              schedule: { kind: "at", at: "2026-03-26T10:00:00.000Z" },
              payload: { kind: "agentTurn", message: "deploy" },
            },
          ],
        })
        .mockResolvedValueOnce({
          total: 1,
          jobs: [
            {
              id: "job-1",
              name: "Reminder: deploy",
              schedule: { kind: "at", at: "2026-03-26T10:00:00.000Z" },
              payload: { kind: "agentTurn", message: "deploy" },
            },
          ],
        }),
    };
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      lastDeterministicCronJob: {
        id: "job-1",
        name: "Reminder: deploy",
        updatedAt: Date.now(),
      },
    };

    const listResult = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query: "jadwal rutin apa yang aktif sekarang",
      sessionEntry,
      runtimeOps,
    });
    const updateResult = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
      },
      query: "ganti webhook job pengingat saya ke https://example.com/hook2",
      sessionEntry,
      runtimeOps,
    });
    const removeResult = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query: "hapus reminder saya yang tadi",
      sessionEntry,
      runtimeOps,
    });

    expect(listResult?.resolvedSchedulingAction?.kind).toBe("cron.list");
    expect(updateResult?.resolvedSchedulingAction).toMatchObject({
      kind: "cron.update",
      params: {
        id: "job-1",
        patch: {
          delivery: {
            mode: "webhook",
            to: "https://example.com/hook2",
          },
        },
      },
    });
    expect(removeResult?.resolvedSchedulingAction).toMatchObject({
      kind: "cron.remove",
      params: { id: "job-1" },
    });
    expect(runtimeOps.listCronJobs).toHaveBeenNthCalledWith(1, {
      enabled: "all",
      includeDisabled: true,
      query: undefined,
    });
    expect(runtimeOps.listCronJobs).toHaveBeenNthCalledWith(2, {
      enabled: "all",
      includeDisabled: true,
      query: undefined,
    });
  });

  it("treats conversational courtesy around cron-list queries as listing all jobs", async () => {
    const runtimeOps = {
      listCronJobs: vi.fn().mockResolvedValue({
        total: 0,
        jobs: [],
      }),
    };

    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query: "boleh lihat jadwal rutin apa yang aktif sekarang?",
      runtimeOps,
    });

    expect(result?.resolvedSchedulingAction).toMatchObject({
      kind: "cron.list",
      params: {
        enabled: "enabled",
        query: undefined,
      },
    });
    expect(runtimeOps.listCronJobs).not.toHaveBeenCalled();
  });

  it("falls back to the last deterministic cron job when update wording is generic", async () => {
    const runtimeOps = {
      listCronJobs: vi.fn().mockResolvedValue({
        total: 2,
        jobs: [
          {
            id: "job-1",
            name: "Reminder: deploy",
            schedule: { kind: "at", at: "2026-03-26T10:00:00.000Z" },
            payload: { kind: "agentTurn", message: "deploy" },
          },
          {
            id: "job-2",
            name: "Reminder: standup",
            schedule: { kind: "at", at: "2026-03-26T11:00:00.000Z" },
            payload: { kind: "agentTurn", message: "standup" },
          },
        ],
      }),
    };

    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
      },
      query: "ganti webhook job pengingat saya ke https://example.com/hook2",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        lastDeterministicCronJob: {
          id: "job-1",
          name: "Reminder: deploy",
          updatedAt: Date.now(),
        },
      },
      runtimeOps,
    });

    expect(runtimeOps.listCronJobs).toHaveBeenCalledWith({
      enabled: "all",
      includeDisabled: true,
      query: undefined,
    });
    expect(result?.resolvedSchedulingAction).toMatchObject({
      kind: "cron.update",
      params: {
        id: "job-1",
        patch: {
          delivery: {
            mode: "webhook",
            to: "https://example.com/hook2",
          },
        },
      },
    });
  });

  it("updates automation jobs with separate action and notify webhook patches", async () => {
    const runtimeOps = {
      listCronJobs: vi.fn().mockResolvedValue({
        total: 1,
        jobs: [
          {
            id: "job-1",
            name: "Automation: lampu kamar mandi",
            schedule: { kind: "cron", expr: "0 2 * * *" },
            payload: {
              kind: "httpAction",
              request: {
                url: "https://old-action.example/hook",
              },
            },
            delivery: {
              mode: "webhook",
              to: "https://old-notify.example/hook",
            },
          },
        ],
      }),
    };

    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {},
      query:
        "ganti action webhook job lampu yang tadi ke https://action.example/v2 lalu kirim status ke webhook https://notify.example/v2",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        lastDeterministicCronJob: {
          id: "job-1",
          name: "Automation: lampu kamar mandi",
          updatedAt: Date.now(),
        },
      },
      runtimeOps,
    });

    expect(result?.resolvedSchedulingAction).toMatchObject({
      kind: "cron.update",
      params: {
        id: "job-1",
        patch: {
          payload: {
            kind: "httpAction",
            request: {
              url: "https://action.example/v2",
            },
          },
          delivery: {
            mode: "webhook",
            to: "https://notify.example/v2",
          },
        },
      },
    });
  });

  it("treats generic `ganti webhook ...` as action-url replacement for automation jobs", async () => {
    const runtimeOps = {
      listCronJobs: vi.fn().mockResolvedValue({
        total: 1,
        jobs: [
          {
            id: "job-1",
            name: "Automation: lampu kamar mandi",
            schedule: { kind: "cron", expr: "0 2 * * *" },
            payload: {
              kind: "httpAction",
              request: {
                url: "https://old-action.example/hook",
              },
            },
            delivery: {
              mode: "announce",
              channel: "webchat",
              to: "agent:main:webchat:direct:test",
            },
          },
        ],
      }),
    };

    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        SessionKey: "agent:main:webchat:direct:test",
        OriginatingChannel: "webchat",
        OriginatingTo: "agent:main:webchat:direct:test",
      },
      query: "ganti webhook ke https://action.example/v2",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        lastDeterministicCronJob: {
          id: "job-1",
          name: "Automation: lampu kamar mandi",
          updatedAt: Date.now(),
        },
      },
      runtimeOps,
    });

    expect(result?.resolvedSchedulingAction).toMatchObject({
      kind: "cron.update",
      params: {
        id: "job-1",
        patch: {
          payload: {
            kind: "httpAction",
            request: {
              url: "https://action.example/v2",
            },
          },
        },
      },
    });
  });

  it("does not misread automation creation text that merely contains an `-update-` slug as cron mutation", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "webchat",
        OriginatingTo: "agent:main:webchat:direct:test",
        SessionKey: "agent:main:webchat:direct:test",
      },
      query:
        "setiap 1 hari nyalakan lampu audit-update-20260327 dengan webhook https://example.com/action-a lalu balas ke chat ini",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
      },
      runtimeOps: {
        listCronJobs: vi.fn().mockResolvedValue({
          total: 0,
          jobs: [],
        }),
      },
    });

    expect(result?.resolvedSchedulingAction).toMatchObject({
      kind: "cron.add",
      params: {
        payload: {
          kind: "httpAction",
          request: {
            url: "https://example.com/action-a",
          },
        },
      },
    });
  });

  it("builds recurring automation with separate action and notify targets", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query:
        "setiap hari jam 2 malam nyalakan lampu kamar mandi dengan webhook https://example.com/hook lalu balas ke chat ini",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.payload).toMatchObject({
      kind: "httpAction",
      request: {
        method: "POST",
        url: "https://example.com/hook",
      },
    });
    expect(result?.resolvedSchedulingAction?.params.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "12345",
    });
  });

  it("keeps explicit action and notify webhook targets separate for automation", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
      },
      query:
        "setiap hari jam 2 malam nyalakan lampu kamar mandi dengan webhook https://action.example/hook lalu kirim status ke webhook https://notify.example/hook",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.payload).toMatchObject({
      kind: "httpAction",
      request: {
        method: "POST",
        url: "https://action.example/hook",
      },
    });
    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "webhook",
      to: "https://notify.example/hook",
    });
  });

  it("keeps pending automation action webhook while follow-up supplies the notify webhook", async () => {
    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {},
      sessionKey: "agent:main:telegram:direct:12345",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "automation",
          rawRequest:
            "setiap hari jam 2 malam nyalakan lampu kamar mandi dengan webhook https://action.example/hook",
          normalizedRequest:
            "setiap hari jam 2 malam nyalakan lampu kamar mandi dengan webhook https://action.example/hook",
          schedule: {
            mode: "cron",
            expr: "0 2 * * *",
            originalText: "setiap hari jam 2 malam",
          },
          recommendedExecutor: "cron",
          allowedDeliveryChoices: ["same_chat", "configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "kirim status ke webhook https://notify.example/hook",
    });

    expect(result?.resolvedSchedulingAction?.kind).toBe("cron.add");
    expect(result?.resolvedSchedulingAction?.params.payload).toMatchObject({
      kind: "httpAction",
      request: {
        url: "https://action.example/hook",
      },
    });
    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "webhook",
      to: "https://notify.example/hook",
    });
  });

  it("does not guess a notify webhook when a second webhook is present without notify cues", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
      },
      query:
        "setiap hari jam 2 malam nyalakan lampu kamar mandi dengan webhook https://action.example/hook dan webhook https://other.example/hook",
    });

    expect(result?.resolvedSchedulingAction).toBeUndefined();
    expect(result?.directReply?.text).toContain("notify target");
    expect(result?.sessionPatch?.pendingSchedulingIntent?.kind).toBe("automation");
  });

  it("clarifies conflicting reminder delivery targets instead of silently collapsing them", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        OriginatingChannel: "telegram",
        OriginatingTo: "12345",
        SessionKey: "agent:main:telegram:direct:12345",
      },
      query:
        "ingatkan saya 2 menit lagi via webhook https://example.com/hook lalu balas ke chat ini",
    });

    expect(result?.resolvedSchedulingAction).toBeUndefined();
    expect(result?.directReply?.text).toContain("lebih dari satu target delivery");
    expect(result?.directReply?.text).toContain("webhook https://example.com/hook");
    expect(result?.directReply?.text).toContain("balas ke chat ini");
    expect(result?.sessionPatch?.pendingSchedulingIntent?.kind).toBe("reminder");
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

  it("asks for a concrete configured channel target when the channel is known but the target is not", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["googlechat"]);

    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {},
      sessionKey: "main",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk deploy",
          normalizedRequest: "ingatkan 1 menit lagi untuk deploy",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          allowedDeliveryChoices: ["configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "google chat aja",
    });

    expect(result?.resolvedSchedulingAction).toBeUndefined();
    expect(result?.directReply?.text).toContain("Google Chat");
    expect(result?.directReply?.text).toContain("masih perlu target");
  });

  it("uses implicit configured-channel targets when the channel has a default delivery target", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram"]);
    resolveCronDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123456789",
      mode: "implicit",
    });

    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {
        SessionKey: "agent:main:webchat:proof-configured-channel",
      },
      sessionKey: "agent:main:webchat:proof-configured-channel",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk deploy",
          normalizedRequest: "ingatkan 1 menit lagi untuk deploy",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          allowedDeliveryChoices: ["configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "telegram aja",
    });

    expect(resolveCronDeliveryTargetMock).toHaveBeenCalledWith(
      { cron: { enabled: true } },
      "main",
      {
        channel: "telegram",
        sessionKey: "agent:main:webchat:proof-configured-channel",
      },
    );
    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "123456789",
      accountId: undefined,
      threadId: undefined,
      replyToId: undefined,
    });
  });

  it("resolves configured-channel follow-ups from a single paired target fallback", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram"]);
    loadSessionStoreMock.mockReturnValue({
      "agent:main:telegram:direct:2081385952": {
        sessionId: "sess-owner",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "telegram:2081385952",
        lastAccountId: "default",
      },
      "agent:main:telegram:group:12345:thread:42": {
        sessionId: "sess-group",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "12345",
      },
    });
    readChannelAllowFromStoreSyncMock.mockReturnValue(["2081385952"]);
    resolveCronDeliveryTargetMock.mockImplementation(async (_cfg, _agentId, params) => {
      if (params.channel !== "telegram") {
        return {
          ok: false,
          channel: params.channel,
          mode: "explicit",
          error: new Error("unexpected channel"),
        };
      }
      if (params.to == null) {
        return {
          ok: false,
          channel: "telegram",
          mode: "implicit",
          error: new Error("missing target"),
        };
      }
      if (
        (params.to === "telegram:2081385952" || params.to === "2081385952") &&
        params.sessionKey === "agent:main:telegram:direct:2081385952"
      ) {
        return {
          ok: true,
          channel: "telegram",
          to: "telegram:2081385952",
          accountId: "default",
          mode: "explicit",
        };
      }
      return {
        ok: false,
        channel: "telegram",
        mode: "explicit",
        error: new Error("invalid target"),
      };
    });

    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {
        SessionKey: "agent:main:webchat:configured-channel-fallback",
      },
      sessionKey: "agent:main:webchat:configured-channel-fallback",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk deploy",
          normalizedRequest: "ingatkan 1 menit lagi untuk deploy",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          allowedDeliveryChoices: ["configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "telegram aja",
    });

    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "telegram:2081385952",
      accountId: "default",
      threadId: undefined,
      replyToId: undefined,
    });
    expect(result?.directReply?.text).toContain("lewat telegram");
    expect(result?.clearPendingScheduling).toBe(true);
    expect(resolveCronDeliveryTargetMock).toHaveBeenCalledWith(
      { cron: { enabled: true } },
      "main",
      {
        channel: "telegram",
        to: "telegram:2081385952",
        sessionKey: "agent:main:telegram:direct:2081385952",
      },
    );
  });

  it("reuses the originating route when the chosen configured channel matches it", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["googlechat"]);

    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {},
      sessionKey: "main",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk deploy",
          normalizedRequest: "ingatkan 1 menit lagi untuk deploy",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          originatingRoute: {
            channel: "googlechat",
            to: "spaces/AAA/messages/BBB",
          },
          allowedDeliveryChoices: ["configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "google chat aja",
    });

    expect(result?.resolvedSchedulingAction?.params.delivery).toMatchObject({
      mode: "announce",
      channel: "googlechat",
      to: "spaces/AAA/messages/BBB",
    });
  });

  it("resolves an explicit configured-channel recipient after an ambiguous clarification", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram"]);
    readChannelAllowFromStoreSyncMock.mockReturnValue(["12345", "2081385952"]);
    resolveCronDeliveryTargetMock.mockImplementation(async (_cfg, _agentId, params) => {
      if (params.channel !== "telegram") {
        return {
          ok: false,
          channel: "telegram",
          mode: "implicit",
          error: new Error("invalid target"),
        };
      }
      if (params.to === "2081385952") {
        return {
          ok: true,
          channel: "telegram",
          to: "2081385952",
          accountId: "default",
          mode: "explicit",
        };
      }
      if (params.to === "12345") {
        return {
          ok: true,
          channel: "telegram",
          to: "12345",
          accountId: "default",
          mode: "explicit",
        };
      }
      return {
        ok: false,
        channel: "telegram",
        mode: "implicit",
        error: new Error("missing target"),
      };
    });

    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {
        SessionKey: "agent:main:webchat:configured-channel-explicit-target",
      },
      sessionKey: "agent:main:webchat:configured-channel-explicit-target",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk deploy lewat telegram",
          normalizedRequest: "ingatkan 1 menit lagi untuk deploy lewat telegram",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          allowedDeliveryChoices: ["configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "telegram:2081385952",
    });

    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "2081385952",
      accountId: "default",
      threadId: undefined,
      replyToId: undefined,
    });
    expect(result?.clearPendingScheduling).toBe(true);
  });

  it("prefers an explicit prefixed configured-channel target over ambiguous fallback candidates", async () => {
    listConfiguredMessageChannelsMock.mockResolvedValue(["telegram"]);
    loadSessionStoreMock.mockReturnValue({
      "agent:main:telegram:direct:2081385952": {
        sessionId: "sess-owner",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "telegram:2081385952",
        lastAccountId: "default",
      },
      "agent:main:telegram:group:12345:thread:42": {
        sessionId: "sess-group",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "12345",
      },
    });
    readChannelAllowFromStoreSyncMock.mockReturnValue(["2081385952"]);
    resolveCronDeliveryTargetMock.mockImplementation(async (_cfg, _agentId, params) => {
      if (params.channel !== "telegram") {
        return {
          ok: false,
          channel: "telegram",
          mode: "implicit",
          error: new Error("invalid channel"),
        };
      }
      if (
        params.sessionKey === "agent:main:webchat:configured-channel-explicit-prefixed" &&
        !params.to
      ) {
        return {
          ok: false,
          channel: "telegram",
          mode: "implicit",
          error: new Error("missing target"),
        };
      }
      if (params.to === "2081385952") {
        return {
          ok: true,
          channel: "telegram",
          to: "telegram:2081385952",
          accountId: "default",
          mode: "explicit",
        };
      }
      return {
        ok: false,
        channel: "telegram",
        mode: "explicit",
        error: new Error("missing target"),
      };
    });

    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {
        SessionKey: "agent:main:webchat:configured-channel-explicit-prefixed",
      },
      sessionKey: "agent:main:webchat:configured-channel-explicit-prefixed",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk deploy lewat telegram telegram:2081385952",
          normalizedRequest:
            "ingatkan 1 menit lagi untuk deploy lewat telegram telegram:2081385952",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          allowedDeliveryChoices: ["configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "telegram:2081385952",
    });

    expect(result?.resolvedSchedulingAction?.params.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "telegram:2081385952",
      accountId: "default",
      threadId: undefined,
      replyToId: undefined,
    });
    expect(result?.clearPendingScheduling).toBe(true);
  });

  it("uses current-session delivery semantics for periodic same-chat monitoring", async () => {
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
          kind: "periodic_monitoring",
          rawRequest: "cek email tiap 30 menit",
          normalizedRequest: "cek email tiap 30 menit",
          schedule: {
            mode: "recurring",
            everyMs: 30 * 60_000,
            originalText: "tiap 30 menit",
          },
          recommendedExecutor: "heartbeat",
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

    expect(result?.resolvedSchedulingAction?.params.sessionTarget).toBe("current");
    expect(result?.resolvedSchedulingAction?.params.payload).toMatchObject({
      kind: "agentTurn",
    });
    expect(result?.resolvedSchedulingAction?.params.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "12345",
    });
  });

  it("fails fast when same-chat is selected for an unavailable current route channel", async () => {
    resolveCronDeliveryTargetMock.mockResolvedValue({
      ok: false,
      channel: "googlechat",
      mode: "explicit",
      error: new Error("Unsupported channel: googlechat"),
    });

    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {
        SessionKey: "agent:main:googlechat:group:spaces/aaa:thread:spaces/aaa/threads/bbb",
      },
      sessionKey: "agent:main:googlechat:group:spaces/aaa:thread:spaces/aaa/threads/bbb",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk deploy",
          normalizedRequest: "ingatkan 1 menit lagi untuk deploy",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          originatingRoute: {
            channel: "googlechat",
            to: "spaces/aaa",
            replyToId: "spaces/aaa/threads/bbb",
          },
          allowedDeliveryChoices: ["same_chat", "configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "balas chat saja",
    });

    expect(result?.resolvedSchedulingAction).toBeUndefined();
    expect(result?.directReply?.text).toContain("Google Chat");
    expect(result?.directReply?.text).toContain("belum tersedia di runtime ini");
  });

  it("uses heartbeat-style internal monitoring when heartbeat remains selected", async () => {
    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {},
      sessionKey: "main",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "periodic_monitoring",
          rawRequest: "cek email tiap 30 menit",
          normalizedRequest: "cek email tiap 30 menit",
          schedule: {
            mode: "recurring",
            everyMs: 30 * 60_000,
            originalText: "tiap 30 menit",
          },
          recommendedExecutor: "heartbeat",
          allowedDeliveryChoices: ["configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "internal aja",
    });

    expect(result?.resolvedSchedulingAction?.params.sessionTarget).toBe("main");
    expect(result?.resolvedSchedulingAction?.params.payload).toMatchObject({
      kind: "systemEvent",
    });
  });

  it("does not accept same-chat follow-ups when same-chat delivery was never allowed", async () => {
    const result = await resolvePendingSchedulingFollowup({
      cfg: { cron: { enabled: true } },
      ctx: {},
      sessionKey: "main",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        pendingSchedulingIntent: {
          kind: "reminder",
          rawRequest: "ingatkan 1 menit lagi untuk deploy",
          normalizedRequest: "ingatkan 1 menit lagi untuk deploy",
          schedule: {
            mode: "relative",
            delayMs: 60_000,
            originalText: "1 menit lagi",
          },
          recommendedExecutor: "cron",
          allowedDeliveryChoices: ["configured_channel", "webhook", "internal"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      query: "balas chat saja",
    });

    expect(result?.resolvedSchedulingAction).toBeUndefined();
    expect(result?.directReply?.text).toContain("belum tersedia");
    expect(result?.sessionPatch?.pendingSchedulingIntent?.allowedDeliveryChoices).toEqual([
      "configured_channel",
      "webhook",
      "internal",
    ]);
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
