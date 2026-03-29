import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeterministicSelfReplyContext } from "./self-facts.js";

describe("buildDeterministicSelfReplyContext", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("lets direct identity questions fall through to the model-backed workspace context", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "siapa anda?",
    });

    expect(result).toBeUndefined();
  });

  it("lets possessive name questions fall through instead of emitting a canned reply", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "siapa namamu?",
    });

    expect(result).toBeUndefined();
  });

  it("lets broader identity phrasing fall through to the main model", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "boleh tahu siapa anda?",
    });

    expect(result).toBeUndefined();
  });

  it("does not hijack owner-style role mutation directives", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "tugasmu adalah menjadi maid pribadiku",
    });

    expect(result).toBeUndefined();
  });

  it("lets role questions fall through so the model can answer from SOUL.md naturally", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "apa tugas anda?",
    });

    expect(result).toBeUndefined();
  });

  it("lets alternate role phrasing fall through instead of using a canned task summary", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "tugas kamu apa?",
    });

    expect(result).toBeUndefined();
  });

  it("lets broader role paraphrases fall through to workspace-backed generation", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "apa peran anda di sini?",
    });

    expect(result).toBeUndefined();
  });

  it("lets English role phrasing fall through instead of hard-wiring a job description", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "what do you do here?",
    });

    expect(result).toBeUndefined();
  });

  it("lets combined identity and role questions fall through to the main model", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "siapa kamu, apa tugasmu?",
    });

    expect(result).toBeUndefined();
  });

  it("returns a concise orchestra model summary from config", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openrouter/openai/gpt-oss-120b",
              fallbacks: ["openrouter/openai/gpt-oss-20b"],
            },
            imageModel: {
              primary: "openrouter/qwen/qwen-2.5-vl-7b-instruct",
              fallbacks: ["openrouter/meta-llama/llama-3.2-11b-vision-instruct"],
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "anda memiliki model orkestra apa saja?",
    });

    expect(result?.directReply.text).toBe(
      "Untuk teks saya memakai gpt-oss-120b, dengan fallback gpt-oss-20b. Untuk OCR dan gambar saya memakai qwen-2.5-vl-7b-instruct, dengan fallback llama-3.2-11b-vision-instruct.",
    );
  });

  it("prefers the effective runtime text model over the global default", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openrouter/openai/gpt-oss-20b",
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "anda memakai orkestra apa?",
      runtime: {
        textPrimary: "anthropic/claude-sonnet-4-5",
        textFallbacks: ["openrouter/openai/gpt-oss-20b"],
      },
    });

    expect(result?.directReply.text).toBe(
      "Untuk teks saya memakai claude-sonnet-4-5, dengan fallback gpt-oss-20b.",
    );
  });

  it("handles short orchestra status phrasing without the word model", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openrouter/openai/gpt-oss-120b",
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "apa anda memakai orkestra?",
    });

    expect(result?.directReply.text).toBe("Ya. Untuk teks saya memakai gpt-oss-120b.");
  });

  it("handles short runtime model questions without the word orchestra", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openrouter/openai/gpt-oss-120b",
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "model apa yang kamu pakai sekarang?",
    });

    expect(result?.directReply.text).toBe("Untuk teks saya memakai gpt-oss-120b.");
  });

  it("handles typo-tolerant orchestra questions", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openrouter/openai/gpt-oss-120b",
            },
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "apakah anda memakai orchesctra model ai?",
    });

    expect(result?.directReply.text).toBe("Untuk teks saya memakai gpt-oss-120b.");
  });

  it("answers Gmail and Calendar capabilities separately", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        hooks: {
          enabled: true,
          gmail: {
            account: "bevansatriaa@gmail.com",
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "apakah anda terhubung dengan gmail untuk membuat calendar?",
    });

    expect(result?.directReply.text).toBe(
      "Gmail didukung dan saat ini sudah dikonfigurasi untuk bevansatriaa@gmail.com. Google Calendar tidak terdeteksi sebagai integrasi aktif di runtime ini.",
    );
  });

  it("does not hijack generic webhook setup questions", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        hooks: {
          enabled: true,
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "cara setup webhook untuk app saya?",
    });

    expect(result).toBeUndefined();
  });

  it("handles runtime integration paraphrases without sentence-specific regexes", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        hooks: {
          enabled: true,
          gmail: {
            account: "bevansatriaa@gmail.com",
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "di runtime ini gmail sama calendar lagi available?",
    });

    expect(result?.directReply.text).toBe(
      "Gmail didukung dan saat ini sudah dikonfigurasi untuk bevansatriaa@gmail.com. Google Calendar tidak terdeteksi sebagai integrasi aktif di runtime ini.",
    );
  });

  it("answers webhook status from runtime-context phrasing", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        hooks: {
          enabled: true,
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "runtime ini webhook statusnya gimana?",
    });

    expect(result?.directReply.text).toBe("Webhook tersedia di runtime ini.");
  });

  it("answers short webhook runtime-status questions deterministically", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        hooks: {
          enabled: true,
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "webhook aktif?",
    });

    expect(result?.directReply.text).toBe("Webhook tersedia di runtime ini.");
  });

  it("does not hijack generic Gmail or Calendar how-to questions", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: {
        hooks: {
          enabled: true,
          gmail: {
            account: "bevansatriaa@gmail.com",
          },
        },
      },
      workspaceDir: "/tmp/workspace",
      query: "buat calendar pakai gmail gimana?",
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined for unrelated questions", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "berapa versi Next.js terbaru?",
    });

    expect(result).toBeUndefined();
  });

  it("does not hijack literal music orchestra questions", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "anda suka musik orchestra apa?",
    });

    expect(result).toBeUndefined();
  });
});
