import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listUserMemoryFacts, upsertUserMemoryFact } from "./user-memory-store.js";

const tempDirs: string[] = [];

async function createWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-user-memory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("user-memory-store", () => {
  it("creates canonical user memory facts under memory/facts", async () => {
    const workspaceDir = await createWorkspace();

    const result = await upsertUserMemoryFact({
      workspaceDir,
      namespace: "preferences",
      key: "database.favorite",
      value: "DuckDB",
      provenance: { source: "test" },
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(result.record.status).toBe("active");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.absPath.replace(/\\/g, "/")).toContain("memory/facts/preferences/");
    expect(facts[0]?.record.value).toBe("DuckDB");
  });

  it("supersedes the previous active fact when the key is updated", async () => {
    const workspaceDir = await createWorkspace();

    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "preferences",
      key: "framework.favorite",
      value: "Next.js",
      provenance: { source: "test" },
    });
    const next = await upsertUserMemoryFact({
      workspaceDir,
      namespace: "preferences",
      key: "framework.favorite",
      value: "Astro",
      provenance: { source: "test" },
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(next.superseded?.status).toBe("superseded");
    expect(facts.filter((entry) => entry.record.status === "active")).toHaveLength(1);
    expect(facts.filter((entry) => entry.record.status === "superseded")).toHaveLength(1);
    expect(facts.find((entry) => entry.record.status === "active")?.record.value).toBe("Astro");
  });
});
