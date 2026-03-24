import { describe, expect, it } from "vitest";
import { sanitizeExternalReplyText } from "./external-outbound-sanitize.js";

describe("sanitizeExternalReplyText", () => {
  it("preserves normal user-facing text", () => {
    expect(sanitizeExternalReplyText("Ya, saya bisa akses RAG.")).toBe("Ya, saya bisa akses RAG.");
  });

  it("truncates leaked planner scaffolding after a user-facing answer", () => {
    const input = [
      "Ya, saya dapat akses RAG.",
      "",
      "Oops…",
      "",
      'Given the conversation, we need to answer: "anda bisa akses rag?"',
      "The user asks if the assistant can access RAG.",
      "Provide concise answer in Indonesian. Ya, saya sudah terhubung.",
    ].join("\n");

    expect(sanitizeExternalReplyText(input)).toBe("Ya, saya sudah terhubung.");
  });

  it("strips pure planner scaffolding entirely", () => {
    const input = [
      'Given the conversation, we need to answer: "anda bisa akses rag?"',
      "The user asks if the assistant can access RAG.",
      "Provide concise answer in Indonesian.",
    ].join(" ");

    expect(sanitizeExternalReplyText(input)).toBe("");
  });

  it("prefers the clean repeated answer when the prefix is visibly corrupted", () => {
    const input = [
      "The **Chroma** vector store is operational:",
      "",
      "- **User-memory collection:** `opencl…` (OK)",
      "- **Docs-KB** collection: `...` (OK",
      "",
      "Oops…",
      "",
      "The answer: The Chroma vector store is up and running:",
      "",
      "- **User-memory collection:** `openclaw-main-user-memory` - OK",
      "- **Docs-KB collection:** `openclaw-main-docs-kb` - OK",
      "- **History collection:** `openclaw-main-history` - OK",
    ].join("\n");

    expect(sanitizeExternalReplyText(input)).toContain("openclaw-main-user-memory");
    expect(sanitizeExternalReplyText(input)).not.toContain("`opencl…`");
  });
});
