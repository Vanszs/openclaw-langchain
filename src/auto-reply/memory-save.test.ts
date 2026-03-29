import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDocsKbRecords } from "../memory/docs-kb-store.js";
import { listUserMemoryFacts } from "../memory/user-memory-store.js";
import { maybeHandleDeterministicMemorySave } from "./memory-save.js";

const tempDirs: string[] = [];
const ownerCfg = {
  commands: {
    ownerAllowFrom: ["telegram:123", "whatsapp:+15551234567"],
  },
};

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
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
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
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "ingat framework favorit saya Next.js",
      workspaceDir,
    });

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
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
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
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

  it("stores full name in a typed owner-profile key", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "ingat nama saya Bevan Satria",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.namespace).toBe("profile");
    expect(facts[0]?.record.key).toBe("name.full");
    expect(facts[0]?.record.value).toBe("Bevan Satria");
  });

  it("syncs active owner facts into USER.md after canonical writes", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "nama saya adalah Bevan Satria",
      workspaceDir,
    });

    const userFile = await fs.readFile(path.join(workspaceDir, "USER.md"), "utf-8");
    expect(userFile).toContain("## Canonical Owner Profile");
    expect(userFile).toContain("<!-- openclaw:canonical-owner:start -->");
    expect(userFile).toContain("- profile.name.full: Bevan Satria");
  });

  it.each(["nama saya adalah Bevan Satria", "saya bernama Bevan Satria"])(
    "stores full name from broader phrasing: %s",
    async (query) => {
      const workspaceDir = await createWorkspace();

      await maybeHandleDeterministicMemorySave({
        ctx: {
          SessionKey: "agent:main:telegram:direct:123",
          Provider: "telegram",
          ChatType: "direct",
          SenderId: "123",
        },
        cfg: ownerCfg,
        query,
        workspaceDir,
      });

      const facts = await listUserMemoryFacts(workspaceDir);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.record.namespace).toBe("profile");
      expect(facts[0]?.record.key).toBe("name.full");
      expect(facts[0]?.record.value).toBe("Bevan Satria");
    },
  );

  it("stores full name from broader English identity phrasing", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "my name is Bevan Satria",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.key).toBe("name.full");
    expect(facts[0]?.record.value).toBe("Bevan Satria");
  });

  it("stores user facts from alternate phrasing without sentence-specific regexes", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "tolong ingat kalau database favorit saya itu DuckDB",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.key).toBe("database.favorite");
    expect(facts[0]?.record.value).toBe("DuckDB");
  });

  it("stores nickname from call-me phrasing", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "panggil saya Bevan",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.namespace).toBe("profile");
    expect(facts[0]?.record.key).toBe("nickname");
    expect(facts[0]?.record.value).toBe("Bevan");
  });

  it("stores nickname from broader English phrasing", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "call me Bevan",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.key).toBe("nickname");
    expect(facts[0]?.record.value).toBe("Bevan");
  });

  it("updates favorite fields even when the wording omits the old value clause", async () => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "ubah editor favorit saya ke Helix",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(result?.reply).toContain("Tersimpan ke user memory");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.key).toBe("editor.favorite");
    expect(facts[0]?.record.value).toBe("Helix");
  });

  it("rejects owner-profile writes from group chats even for the owner", async () => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:group:ops",
        Provider: "telegram",
        ChatType: "group",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "ingat framework favorit saya Astro",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(result?.reply).toContain("Owner profile hanya bisa ditulis");
    expect(facts).toHaveLength(0);
  });

  it.each([
    {
      name: "direct non-owner",
      ctx: {
        SessionKey: "agent:main:telegram:direct:999",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "999",
      },
    },
    {
      name: "group non-owner",
      ctx: {
        SessionKey: "agent:main:telegram:group:ops",
        Provider: "telegram",
        ChatType: "group",
        SenderId: "999",
      },
    },
  ])("rejects owner-profile writes for $name", async ({ ctx }) => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx,
      cfg: ownerCfg,
      query: "ingat framework favorit saya Astro",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(result?.reply).toContain("Owner profile hanya bisa ditulis");
    expect(facts).toHaveLength(0);
  });

  it("rejects internal operator-admin direct chats that do not match an explicit owner", async () => {
    const workspaceDir = await createWorkspace();

    const result = await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "telegram",
        ChatType: "direct",
        SenderId: "cli",
        GatewayClientScopes: ["operator.admin"],
      },
      cfg: ownerCfg,
      query: "ingat nama saya Bevan Satria",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(result?.reply).toContain("Owner profile hanya bisa ditulis");
    expect(facts).toHaveLength(0);
  });

  it("updates the same canonical owner profile across channels on purpose", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "ingat database favorit saya DuckDB",
      workspaceDir,
    });
    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:whatsapp:direct:+15551234567",
        Provider: "whatsapp",
        ChatType: "direct",
        SenderId: "+15551234567",
      },
      cfg: ownerCfg,
      query: "ganti database favorit saya dari DuckDB jadi PostgreSQL",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    const activeFacts = facts.filter((entry) => entry.record.status === "active");
    const supersededFacts = facts.filter((entry) => entry.record.status === "superseded");
    expect(activeFacts).toHaveLength(1);
    expect(activeFacts[0]?.record.key).toBe("database.favorite");
    expect(activeFacts[0]?.record.value).toBe("PostgreSQL");
    expect(supersededFacts).toHaveLength(1);
    expect(supersededFacts[0]?.record.provenance.provider).toBe("telegram");
  });

  it("updates the same canonical owner profile across external and internal owner channels", async () => {
    const workspaceDir = await createWorkspace();
    const cfg = {
      commands: {
        ownerAllowFrom: ["telegram:123", "webchat:cli"],
      },
    };

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg,
      query: "ingat editor favorit saya Helix",
      workspaceDir,
    });
    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:webchat:direct:cli",
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SenderId: "cli",
      },
      cfg,
      query: "ganti editor favorit saya dari Helix jadi Zed",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    const activeFacts = facts.filter((entry) => entry.record.status === "active");
    const supersededFacts = facts.filter((entry) => entry.record.status === "superseded");
    expect(activeFacts).toHaveLength(1);
    expect(activeFacts[0]?.record.key).toBe("editor.favorite");
    expect(activeFacts[0]?.record.value).toBe("Zed");
    expect(supersededFacts).toHaveLength(1);
    expect(supersededFacts[0]?.record.value).toBe("Helix");
  });

  it("records originating external channel provenance for gateway-delivered owner saves", async () => {
    const workspaceDir = await createWorkspace();

    await maybeHandleDeterministicMemorySave({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        ChatType: "direct",
        SenderId: "123",
      },
      cfg: ownerCfg,
      query: "ingat nama saya Bevan Satria",
      workspaceDir,
    });

    const facts = await listUserMemoryFacts(workspaceDir);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.record.provenance.source).toBe("telegram");
    expect(facts[0]?.record.provenance.provider).toBe("telegram");
    expect(facts[0]?.record.provenance.surface).toBe("telegram");
    expect(facts[0]?.record.provenance.channelId).toBe("123");
  });
});
