import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

const { readChannelAllowFromStoreSyncMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreSyncMock: vi.fn(() => []),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStoreSync: readChannelAllowFromStoreSyncMock,
}));

installDiscordRegistryHooks();

describe("senderIsOwner only reflects explicit owner authorization", () => {
  it("does not treat direct-message senders as owners when no ownerAllowFrom is configured", () => {
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("does not treat group-chat senders as owners when no ownerAllowFrom is configured", () => {
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("senderIsOwner is false when ownerAllowFrom is configured and sender does not match", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:789",
      SenderId: "789",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
  });

  it("senderIsOwner is true when ownerAllowFrom matches sender", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:456",
      SenderId: "456",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
  });

  it("senderIsOwner is true when ownerAllowFrom is wildcard (*)", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["*"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:anyone",
      SenderId: "anyone",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.senderIsOwnerExplicit).toBe(true);
    expect(auth.senderIsOwnerByScope).toBe(false);
  });

  it("resolves built-in channel owner prefixes without relying on plugin registry aliases", () => {
    const cfg = {
      channels: { telegram: {} },
      commands: { ownerAllowFrom: ["telegram:2081385952"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:2081385952",
      SenderId: "2081385952",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBe("telegram");
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.senderIsOwnerExplicit).toBe(true);
  });

  it("falls back to pairing allowFrom stores for built-in direct channels", () => {
    readChannelAllowFromStoreSyncMock.mockReturnValue(["2081385952"]);
    const cfg = {
      channels: { telegram: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:2081385952",
      SenderId: "2081385952",
      AccountId: "default",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBe("telegram");
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.senderIsOwnerExplicit).toBe(true);
  });

  it("senderIsOwner is true for internal operator.admin sessions", () => {
    const cfg = {} as OpenClawConfig;

    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.admin"],
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.senderIsOwnerExplicit).toBe(false);
    expect(auth.senderIsOwnerByScope).toBe(true);
  });

  it("matches explicit internal webchat owner prefixes for direct sessions", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["telegram:2081385952", "webchat:cli"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SenderId: "cli",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.senderIsOwnerExplicit).toBe(true);
    expect(auth.ownerList).toEqual(["cli"]);
  });
});
