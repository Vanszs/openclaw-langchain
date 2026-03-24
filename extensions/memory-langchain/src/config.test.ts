import { describe, expect, it } from "vitest";
import { resolveLangchainCollectionName, resolveLangchainPluginStorageState } from "./config.js";

describe("resolveLangchainCollectionName", () => {
  it("splits collection names by domain", () => {
    expect(
      resolveLangchainCollectionName({
        collectionPrefix: "openclaw",
        agentId: "main",
        domain: "user_memory",
      }),
    ).toBe("openclaw-main-user-memory");
    expect(
      resolveLangchainCollectionName({
        collectionPrefix: "openclaw",
        agentId: "main",
        domain: "docs_kb",
      }),
    ).toBe("openclaw-main-docs-kb");
    expect(
      resolveLangchainCollectionName({
        collectionPrefix: "openclaw",
        agentId: "main",
        domain: "history",
      }),
    ).toBe("openclaw-main-history");
  });
});

describe("resolveLangchainPluginStorageState", () => {
  it("uses OPENCLAW_CHROMA_URL when plugin config omits chromaUrl", () => {
    const result = resolveLangchainPluginStorageState({
      cfg: {},
      env: {
        OPENCLAW_CHROMA_URL: "http://127.0.0.1:8889",
        HOME: "/tmp/home",
      },
    });

    expect(result.chromaUrl).toBe("http://127.0.0.1:8889");
  });
});
