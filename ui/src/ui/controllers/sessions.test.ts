import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessions,
  deleteSession,
  deleteSessionAndRefresh,
  subscribeSessions,
  type SessionsState,
} from "./sessions.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

if (!("window" in globalThis)) {
  Object.assign(globalThis, {
    window: {
      confirm: () => false,
    },
  });
}

function createState(request: RequestFn, overrides: Partial<SessionsState> = {}): SessionsState {
  return {
    client: { request } as unknown as SessionsState["client"],
    connected: true,
    sessionsLoading: false,
    sessionsResult: null,
    sessionsError: null,
    sessionsFilterActive: "0",
    sessionsFilterLimit: "0",
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("subscribeSessions", () => {
  it("registers for session change events", async () => {
    const request = vi.fn(async () => ({ subscribed: true }));
    const state = createState(request);

    await subscribeSessions(state);

    expect(request).toHaveBeenCalledWith("sessions.subscribe", {});
    expect(state.sessionsError).toBeNull();
  });
});

describe("deleteSessionAndRefresh", () => {
  it("refreshes sessions after a successful delete", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionAndRefresh(state, "agent:main:test");

    expect(deleted).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.delete", {
      key: "agent:main:test",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(state.sessionsError).toBeNull();
    expect(state.sessionsLoading).toBe(false);
  });

  it("does not refresh sessions when user cancels delete", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { sessionsError: "existing error" });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const deleted = await deleteSessionAndRefresh(state, "agent:main:test");

    expect(deleted).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.sessionsError).toBe("existing error");
    expect(state.sessionsLoading).toBe(false);
  });

  it("does not refresh sessions when delete fails and preserves the delete error", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        throw new Error("delete boom");
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const deleted = await deleteSessionAndRefresh(state, "agent:main:test");

    expect(deleted).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:main:test",
      deleteTranscript: true,
    });
    expect(state.sessionsError).toContain("delete boom");
    expect(state.sessionsLoading).toBe(false);
  });
});

describe("deleteSession", () => {
  it("returns false when already loading", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { sessionsLoading: true });

    const deleted = await deleteSession(state, "agent:main:test");

    expect(deleted).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("loadSessions", () => {
  it("clears the active session model override when custom orchestra is enabled", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 1,
          defaults: {
            modelProvider: "openrouter",
            model: "openai/gpt-oss-120b",
            contextTokens: null,
          },
          sessions: [
            {
              key: "main",
              modelProvider: "openrouter",
              model: "openai/gpt-oss-20b",
            },
          ],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, key: "main" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      customOrchestraEnabled: true,
      sessionKey: "main",
      chatModelOverrides: { main: { kind: "raw", value: "openrouter/openai/gpt-oss-20b" } },
    });

    await loadSessions(state);

    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.patch", {
      key: "main",
      model: null,
    });
    expect(state.sessionsResult?.sessions[0]?.model).toBeUndefined();
    expect(state.sessionsResult?.sessions[0]?.modelProvider).toBeUndefined();
    expect(state.chatModelOverrides?.main).toBeNull();
  });

  it("keeps session overrides untouched when custom orchestra is disabled", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 1,
          defaults: {
            modelProvider: "openrouter",
            model: "openai/gpt-oss-120b",
            contextTokens: null,
          },
          sessions: [
            {
              key: "main",
              modelProvider: "openrouter",
              model: "openai/gpt-oss-20b",
            },
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      customOrchestraEnabled: false,
      sessionKey: "main",
    });

    await loadSessions(state);

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.sessionsResult?.sessions[0]?.model).toBe("openai/gpt-oss-20b");
    expect(state.sessionsResult?.sessions[0]?.modelProvider).toBe("openrouter");
  });
});
