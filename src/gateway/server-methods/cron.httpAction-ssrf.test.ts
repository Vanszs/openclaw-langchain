import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

import { cronHandlers } from "./cron.js";

describe("cronHandlers httpAction SSRF validation", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({
      cron: {},
    });
  });

  it("rejects cron.add for private-network httpAction targets by default", async () => {
    const addMock = vi.fn();
    const respond = vi.fn();

    await cronHandlers["cron.add"]({
      params: {
        name: "private-http-action",
        schedule: { kind: "cron", expr: "0 2 * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "httpAction",
          request: {
            method: "POST",
            url: "http://192.168.1.2/hook",
          },
        },
        delivery: {
          mode: "none",
        },
      },
      respond,
      context: {
        cron: {
          add: addMock,
        },
        logGateway: {
          info: vi.fn(),
        },
      },
    } as never);

    expect(addMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("blocked by SSRF policy"),
      }),
    );
  });

  it("rejects cron.update when patching httpAction to a private-network target", async () => {
    const updateMock = vi.fn();
    const respond = vi.fn();

    await cronHandlers["cron.update"]({
      params: {
        id: "job-1",
        patch: {
          payload: {
            kind: "httpAction",
            request: {
              method: "POST",
              url: "http://127.0.0.1:8080/internal",
            },
          },
        },
      },
      respond,
      context: {
        cron: {
          update: updateMock,
        },
        logGateway: {
          info: vi.fn(),
        },
      },
    } as never);

    expect(updateMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("blocked by SSRF policy"),
      }),
    );
  });
});
