import { afterEach, describe, expect, it } from "vitest";
import {
  clearMemoryManagerProvidersForTests,
  registerMemoryManagerProvider,
} from "./plugin-manager-registry.js";

describe("memory manager provider registry", () => {
  afterEach(() => {
    clearMemoryManagerProvidersForTests();
  });

  it("keeps providers visible across module reloads", async () => {
    const provider = () => null;
    registerMemoryManagerProvider("memory-langchain", provider);

    const reloaded = await import("./plugin-manager-registry.js?reload=second");

    expect(reloaded.getMemoryManagerProvider("memory-langchain")).toBe(provider);
  });
});
