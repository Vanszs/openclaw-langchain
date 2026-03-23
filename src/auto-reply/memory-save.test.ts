import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDocsKbRecords } from "../memory/docs-kb-store.js";
import { listUserMemoryFacts } from "../memory/user-memory-store.js";
import { maybeHandleDeterministicMemorySave } from "./memory-save.js";

const tempDirs: string[] = [];

async function createWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-save-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("maybeHandleDeterministicMemorySave", () => {
  it("stores explicit user facts into canonical user_memory", async () => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
      },
      query: "simpan bahwa database favorit saya DuckDB",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(result?.reply).toContain("Tersimpan ke user memory");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.key).toBe("database.favorite");
    expect(facts[0]?.record.value).toBe("DuckDB");
  });

  it("stores explicit docs saves into canonical docs_kb", async () => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        ReplyToBody: "Gateway tokens are configured under gateway.auth.token.",
        SessionKey: "agent:main:webchat:main",
        Provider: "webchat",
      },
      query: "simpan hasil riset docs OpenClaw ini",
      workspaceDir,
      retrievalContext: {
        domain: "docs_kb",
        note: "Retrieved context",
      },
    });

    const records = await listDocsKbRecords(workspaceDir);
    expect(result?.reply).toContain("Tersimpan ke knowledge base");
    expect(records).toHaveLength(1);
    expect(records[0]?.record.title).toContain("Gateway tokens are configured");
  });

  it("upserts user-memory updates and supersedes the prior fact", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
      },
      query: "ingat framework favorit saya Next.js",
      workspaceDir,
    });

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
      },
      query: "ganti framework favorit saya dari Next.js jadi Astro",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    const activeFacts = facts.filter((entry) => entry.record.status === "active");
    const supersededFacts = facts.filter((entry) => entry.record.status === "superseded");
    expect(result?.reply).toContain("Record lama disupersede");
    expect(activeFacts).toHaveLength(1);
    expect(activeFacts[0]?.record.value).toBe("Astro");
    expect(supersededFacts).toHaveLength(1);
    expect(supersededFacts[0]?.record.value).toBe("Next.js");
  });

  it("does not save the save command itself as docs content when no target text exists", async () => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:webchat:main",
        Provider: "webchat",
      },
      query: "simpan dokumen ini",
      workspaceDir,
    });

    const records = await listDocsKbRecords(workspaceDir);
    expect(result).toEqual({
      reply:
        "Saya butuh teks atau dokumen target untuk disimpan. Balas sambil reply ke hasil yang dimaksud, atau kirim ulang teks/dokumennya.",
    });
    expect(records).toHaveLength(0);
  });

  it("extracts explicit user facts from retrieved attachment/doc text", async () => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        ReplyToBody: "Invoice number: ZX-4419",
        SessionKey: "agent:main:webchat:main",
        Provider: "webchat",
      },
      query: "ingat nomor invoice saya",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(result?.reply).toContain("Tersimpan ke user memory");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.key).toBe("invoice.number");
    expect(facts[0]?.record.value).toBe("ZX-4419");
  });

  it("asks for clarification on ambiguous save after docs retrieval", async () => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        ReplyToBody: "Gateway tokens are configured under gateway.auth.token.",
      },
      query: "simpan semua informasi tersebut dan ingat",
      workspaceDir,
      retrievalContext: {
        domain: "docs_kb",
        note: "Retrieved context",
      },
    });

    expect(result).toEqual({
      reply:
        "Perlu klarifikasi sebelum menyimpan: simpan sebagai knowledge dokumen, atau ingat sebagai fakta tentang Anda?",
    });
  });
});
