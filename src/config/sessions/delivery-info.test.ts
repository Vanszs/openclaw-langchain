import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "./types.js";

const storeState = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
}));

vi.mock("../io.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("./paths.js", () => ({
  resolveStorePath: () => "/tmp/sessions.json",
}));

vi.mock("./store.js", () => ({
  loadSessionStore: () => storeState.store,
}));

let extractDeliveryInfo: typeof import("./delivery-info.js").extractDeliveryInfo;
let findMirroredTranscriptSessionKey: typeof import("./delivery-info.js").findMirroredTranscriptSessionKey;
let parseSessionThreadInfo: typeof import("./delivery-info.js").parseSessionThreadInfo;

const buildEntry = (deliveryContext: SessionEntry["deliveryContext"]): SessionEntry => ({
  sessionId: "session-1",
  updatedAt: Date.now(),
  deliveryContext,
});

beforeEach(async () => {
  vi.resetModules();
  storeState.store = {};
  ({ extractDeliveryInfo, findMirroredTranscriptSessionKey, parseSessionThreadInfo } =
    await import("./delivery-info.js"));
});

describe("extractDeliveryInfo", () => {
  it("parses base session and thread/topic ids", () => {
    expect(parseSessionThreadInfo("agent:main:telegram:group:1:topic:55")).toEqual({
      baseSessionKey: "agent:main:telegram:group:1",
      threadId: "55",
    });
    expect(parseSessionThreadInfo("agent:main:slack:channel:C1:thread:123.456")).toEqual({
      baseSessionKey: "agent:main:slack:channel:C1",
      threadId: "123.456",
    });
    expect(parseSessionThreadInfo("agent:main:telegram:dm:user-1")).toEqual({
      baseSessionKey: "agent:main:telegram:dm:user-1",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo(undefined)).toEqual({
      baseSessionKey: undefined,
      threadId: undefined,
    });
  });

  it("returns deliveryContext for direct session keys", () => {
    const sessionKey = "agent:main:webchat:dm:user-123";
    storeState.store[sessionKey] = buildEntry({
      channel: "webchat",
      to: "webchat:user-123",
      accountId: "default",
    });

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("falls back to base sessions for :thread: keys", () => {
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    storeState.store[baseKey] = buildEntry({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      },
      threadId: "1234567890.123456",
    });
  });

  it("falls back to base sessions for :topic: keys", () => {
    const baseKey = "agent:main:telegram:group:98765";
    const topicKey = `${baseKey}:topic:55`;
    storeState.store[baseKey] = buildEntry({
      channel: "telegram",
      to: "group:98765",
      accountId: "main",
    });

    const result = extractDeliveryInfo(topicKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
      },
      threadId: "55",
    });
  });

  it("derives delivery targets from explicit channel-scoped session keys when store data is incomplete", () => {
    const threadKey = "agent:main:telegram:group:98765:topic:55";
    storeState.store[threadKey] = buildEntry({
      channel: "telegram",
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "98765",
        accountId: undefined,
      },
      threadId: "55",
    });
  });

  it("derives account-scoped delivery targets from explicit session keys", () => {
    const sessionKey = "agent:main:telegram:account-a:direct:6812765697";
    storeState.store[sessionKey] = buildEntry({
      channel: "telegram",
    });

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "6812765697",
        accountId: "account-a",
      },
      threadId: undefined,
    });
  });

  it("finds the most specific mirrored transcript session for a delivery target", () => {
    storeState.store["agent:main:telegram:direct:2081385952"] = {
      sessionId: "direct-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "telegram",
        to: "2081385952",
        accountId: "default",
      },
    };
    storeState.store["agent:main:telegram:direct:2081385952:run:abc"] = {
      sessionId: "run-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "telegram",
        to: "2081385952",
        accountId: "default",
      },
    };

    expect(
      findMirroredTranscriptSessionKey({
        cfg: { session: { store: "/tmp/sessions.json" } },
        agentId: "main",
        channel: "telegram",
        to: "2081385952",
        accountId: "default",
      }),
    ).toBe("agent:main:telegram:direct:2081385952");
  });

  it("keeps thread-specific routing when finding mirrored transcript sessions", () => {
    storeState.store["agent:main:googlechat:group:spaces/aaa"] = {
      sessionId: "base-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "googlechat",
        to: "spaces/aaa",
      },
    };
    storeState.store["agent:main:googlechat:group:spaces/aaa:thread:spaces/aaa/threads/bbb"] = {
      sessionId: "thread-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "googlechat",
        to: "spaces/aaa",
        threadId: "spaces/aaa/threads/bbb",
      },
    };

    expect(
      findMirroredTranscriptSessionKey({
        cfg: { session: { store: "/tmp/sessions.json" } },
        agentId: "main",
        channel: "googlechat",
        to: "spaces/aaa",
        threadId: "spaces/aaa/threads/bbb",
      }),
    ).toBe("agent:main:googlechat:group:spaces/aaa:thread:spaces/aaa/threads/bbb");
  });
});
