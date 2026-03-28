import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { deliverOutboundPayloads } = await import("../../infra/outbound/deliver.js");

describe("runCronIsolatedAgentTurn — exact reminder direct delivery", () => {
  setupRunCronIsolatedAgentTurnSuite();

  beforeEach(() => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "12345",
      source: "delivery",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "12345",
      accountId: "default",
      threadId: undefined,
      replyToId: undefined,
      mode: "explicit",
    });
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ ok: true } as never]);
  });

  it("delivers exact reminders without spawning a model run", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: {
          id: "exact-reminder-direct",
          name: "Exact Reminder Direct",
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "12345",
            accountId: "default",
          },
          payload: {
            kind: "agentTurn",
            message:
              "Kirim pengingat ini sekarang. Balas dengan tepat teks berikut dan jangan tambah apa pun:\nPengingat: exact reminder direct",
            timeoutSeconds: 1,
          },
        },
        message: "exact reminder direct",
        sessionKey: "cron:exact-reminder-direct",
      }),
    );

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "12345",
        accountId: "default",
        payloads: [{ text: "Pengingat: exact reminder direct" }],
      }),
    );
    expect(result).toMatchObject({
      status: "ok",
      outputText: "Pengingat: exact reminder direct",
      summary: "Pengingat: exact reminder direct",
      deliveryAttempted: true,
      delivered: true,
    });
  });
});
