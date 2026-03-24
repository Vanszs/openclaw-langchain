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
      },
      query: "ingatkan saya 2 menit lagi untuk makan",
    });

    expect(result?.directReply.text).toContain("balas kembali ke chat ini");
    expect(result?.directReply.text).toContain("kirim ke webhook");
    expect(result?.directReply.text).toContain("simpan internal saja");
  });

  it("routes periodic monitoring toward heartbeat clarification", async () => {
    const result = await buildDeterministicSchedulingContext({
      cfg: { cron: { enabled: true } },
      ctx: {
        Surface: "webchat",
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
      },
      query: "ingatkan saya 2 menit lagi dan balas ke chat ini",
    });

    expect(result).toBeUndefined();
  });
});
