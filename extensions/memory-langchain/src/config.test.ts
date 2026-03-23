import { describe, expect, it } from "vitest";
import { resolveLangchainCollectionName } from "./config.js";

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
