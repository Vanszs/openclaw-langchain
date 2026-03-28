import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listActiveUserMemoryFacts,
  listUserMemoryFacts,
  resolveUserMemoryFactPath,
  upsertUserMemoryFact,
} from "./user-memory-store.js";

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

  it("heals pre-existing duplicate active facts on the next upsert", async () => {
    const workspaceDir = await createWorkspace();
    const olderPath = resolveUserMemoryFactPath({
      workspaceDir,
      namespace: "profile",
      id: "profile-name.full-older",
    });
    const newerPath = resolveUserMemoryFactPath({
      workspaceDir,
      namespace: "profile",
      id: "profile-name.full-newer",
    });
    await fs.mkdir(path.dirname(olderPath), { recursive: true });
    await fs.writeFile(
      olderPath,
      `${JSON.stringify(
        {
          id: "profile-name.full-older",
          namespace: "profile",
          key: "name.full",
          value: "Alpha",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          provenance: { source: "test", provider: "telegram" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      newerPath,
      `${JSON.stringify(
        {
          id: "profile-name.full-newer",
          namespace: "profile",
          key: "name.full",
          value: "Beta",
          status: "active",
          createdAt: 2,
          updatedAt: 2,
          provenance: { source: "test", provider: "webchat" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "profile",
      key: "name.full",
      value: "Gamma",
      provenance: { source: "test", provider: "whatsapp" },
      nowMs: 10,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    const active = facts.filter((entry) => entry.record.status === "active");
    const superseded = facts.filter((entry) => entry.record.status === "superseded");
    expect(active).toHaveLength(1);
    expect(active[0]?.record.value).toBe("Gamma");
    expect(superseded).toHaveLength(2);
    expect(await listActiveUserMemoryFacts(workspaceDir)).toHaveLength(1);
  });

  it("serializes concurrent writes so only one active fact remains", async () => {
    const workspaceDir = await createWorkspace();

    await Promise.all([
      upsertUserMemoryFact({
        workspaceDir,
        namespace: "profile",
        key: "name.full",
        value: "Telegram Owner",
        provenance: { source: "telegram", provider: "telegram", senderId: "123" },
      }),
      upsertUserMemoryFact({
        workspaceDir,
        namespace: "profile",
        key: "name.full",
        value: "WebChat Owner",
        provenance: { source: "webchat", provider: "webchat", senderId: "cli" },
      }),
    ]);

    const facts = await listUserMemoryFacts(workspaceDir);
    const active = facts.filter((entry) => entry.record.status === "active");
    const superseded = facts.filter((entry) => entry.record.status === "superseded");
    expect(active).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(["Telegram Owner", "WebChat Owner"]).toContain(active[0]?.record.value);
    expect(await listActiveUserMemoryFacts(workspaceDir)).toHaveLength(1);
  });
});
