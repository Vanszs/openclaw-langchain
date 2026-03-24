import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/identity-file.js", () => ({
  loadAgentIdentityFromWorkspace: vi.fn(),
}));

import { loadAgentIdentityFromWorkspace } from "../agents/identity-file.js";
import { buildDeterministicSelfReplyContext } from "./self-facts.js";

describe("buildDeterministicSelfReplyContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a concise identity reply from IDENTITY.md", async () => {
    vi.mocked(loadAgentIdentityFromWorkspace).mockReturnValue({
      name: "Hypatia",
    });

    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "siapa anda?",
    });

    expect(result).toEqual({
      directReply: {
        text: "Saya Hypatia.",
      },
    });
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

  it("returns undefined for unrelated questions", async () => {
    const result = await buildDeterministicSelfReplyContext({
      cfg: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      query: "berapa versi Next.js terbaru?",
    });

    expect(result).toBeUndefined();
  });
});
