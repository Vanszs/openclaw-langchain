import { describe, expect, it } from "vitest";
import { tokenizeSemanticText } from "./semantic-concepts.js";

describe("tokenizeSemanticText", () => {
  it("matches multi-word aliases across token spans", () => {
    const tokens = tokenizeSemanticText("please reply here in two minutes", {
      delivery_same_chat: ["reply here"],
      courtesy: ["please"],
    });

    expect(tokens.find((token) => token.value === "reply")?.concepts).toContain(
      "delivery_same_chat",
    );
    expect(tokens.find((token) => token.value === "here")?.concepts).toContain(
      "delivery_same_chat",
    );
    expect(tokens.find((token) => token.value === "please")?.concepts).toContain("courtesy");
  });

  it("matches Indonesian possessive suffix variants without exact-word lists", () => {
    const tokens = tokenizeSemanticText("siapa namamu dan apa tugasmu", {
      facet_name: ["nama"],
      facet_role: ["tugas"],
    });

    expect(tokens.find((token) => token.value === "namamu")?.concepts).toContain("facet_name");
    expect(tokens.find((token) => token.value === "tugasmu")?.concepts).toContain("facet_role");
  });
});
