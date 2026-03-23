import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDocsKbRecords, storeDocsKbRecord } from "./docs-kb-store.js";

const tempDirs: string[] = [];

async function createWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-docs-kb-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("docs-kb-store", () => {
  it("stores canonical knowledge notes under memory/knowledge", async () => {
    const workspaceDir = await createWorkspace();

    const result = await storeDocsKbRecord({
      workspaceDir,
      title: "Gateway Token Notes",
      body: "Use openclaw config get gateway.auth.token to inspect the configured token.",
      sourceType: "docs",
      provenance: { source: "test" },
    });

    const records = await listDocsKbRecords(workspaceDir);
    expect(result.record.version).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.record.title).toBe("Gateway Token Notes");
    expect(records[0]?.absMetaPath.replace(/\\/g, "/")).toContain("memory/knowledge/");
  });

  it("supersedes older knowledge notes with the same doc id", async () => {
    const workspaceDir = await createWorkspace();

    await storeDocsKbRecord({
      workspaceDir,
      docId: "openclaw-gateway-token",
      title: "Gateway Token v1",
      body: "Old body",
      sourceType: "docs",
      provenance: { source: "test" },
    });
    const updated = await storeDocsKbRecord({
      workspaceDir,
      docId: "openclaw-gateway-token",
      title: "Gateway Token v2",
      body: "New body",
      sourceType: "docs",
      provenance: { source: "test" },
    });

    const records = await listDocsKbRecords(workspaceDir);
    expect(updated.superseded?.status).toBe("superseded");
    expect(records.filter((entry) => entry.record.status === "active")).toHaveLength(1);
    expect(records.find((entry) => entry.record.status === "active")?.record.title).toBe(
      "Gateway Token v2",
    );
  });
});
