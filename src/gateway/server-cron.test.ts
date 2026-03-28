import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

const {
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  deliverOutboundPayloadsMock,
  resolveDeliveryTargetMock,
  runCronIsolatedAgentTurnMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  deliverOutboundPayloadsMock: vi.fn(),
  resolveDeliveryTargetMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeatNow(...args: unknown[]) {
  return requestHeartbeatNowMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../cron/isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

import { buildGatewayCronService } from "./server-cron.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    deliverOutboundPayloadsMock.mockReset();
    resolveDeliveryTargetMock.mockReset();
    runCronIsolatedAgentTurnMock.mockClear();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: {
        status: 204,
        ok: true,
      },
      release: vi.fn().mockResolvedValue(undefined),
    });
    deliverOutboundPayloadsMock.mockResolvedValue([{ ok: true }]);
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "12345",
      accountId: undefined,
      threadId: "thread-1",
      replyToId: "reply-1",
      mode: "explicit",
    });
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("passes custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:project-alpha-monitor",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: "project-alpha-monitor",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("runs httpAction separately from notify delivery and only allows private targets through explicit allowlists", async () => {
    const cfg = createCronConfig("server-cron-http-action");
    cfg.cron = {
      ...cfg.cron,
      httpAction: {
        allowedHostnames: ["127.0.0.1"],
        hostnameAllowlist: ["127.0.0.1"],
      },
    };
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "bathroom-light-on",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "httpAction",
          request: {
            method: "POST",
            url: "http://127.0.0.1:18789/actions/light-on",
            headers: {
              "Content-Type": "application/json",
            },
            body: '{"device":"bathroom-light","state":"on"}',
          },
          success: {
            summaryText: "Lampu kamar mandi sudah dinyalakan.",
          },
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "12345",
          threadId: "thread-1",
          replyToId: "reply-1",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://127.0.0.1:18789/actions/light-on",
          policy: {
            allowPrivateNetwork: false,
            allowedHostnames: ["127.0.0.1"],
            hostnameAllowlist: ["127.0.0.1"],
          },
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: '{"device":"bathroom-light","state":"on"}',
          },
        }),
      );
      expect(resolveDeliveryTargetMock).toHaveBeenCalledWith(
        cfg,
        "main",
        expect.objectContaining({
          channel: "telegram",
          to: "12345",
          threadId: "thread-1",
          replyToId: "reply-1",
        }),
      );
      expect(deliverOutboundPayloadsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "telegram",
          to: "12345",
          threadId: "thread-1",
          replyToId: "reply-1",
          payloads: [{ text: "Lampu kamar mandi sudah dinyalakan." }],
        }),
      );
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private httpAction targets by default when no explicit allowlist is configured", async () => {
    const cfg = createCronConfig("server-cron-http-action-default-block");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValueOnce(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "bathroom-light-on-private-default-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "httpAction",
          request: {
            method: "POST",
            url: "http://127.0.0.1:18789/actions/light-on",
          },
          failure: {
            summaryText: "Automation gagal: light-on",
          },
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "12345",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://127.0.0.1:18789/actions/light-on",
          policy: undefined,
        }),
      );
      expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
      expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });
});
