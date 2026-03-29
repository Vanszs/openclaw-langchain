import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt durable workspace guidance", () => {
  it("forbids exact-word durable mutation routing and guessed template edits", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read", "write", "edit", "memory_search", "memory_get"],
    });

    expect(prompt).toContain("## Durable Workspace Changes");
    expect(prompt).toContain("Choose the target surface by meaning, not by exact wording");
    expect(prompt).toContain("Do not require any magic phrase such as 'from now on'");
    expect(prompt).toContain(
      "Never build or rely on a private keyword bank, regex trigger list, or exact-sentence matcher",
    );
    expect(prompt).toContain(
      "Strict rule: never gate durable mutations on the presence of specific words, phrases, or language-specific trigger dictionaries.",
    );
    expect(prompt).toContain(
      "If the user intent is persistent/future-facing, treat it as durable even when wording is novel",
    );
    expect(prompt).toContain(
      "Declarative owner corrections about who you are, what your role is, how you should relate to the owner, or how you should behave in future turns count as durable mutations",
    );
    expect(prompt).toContain(
      "Owner-direct requests to change your name, role, persona, or durable behavior must be executed as workspace mutations within policy scope",
    );
    expect(prompt).toContain(
      "Do not treat owner identity/persona corrections as mere acknowledgements. Apply the canonical change first, then answer from the updated canon.",
    );
    expect(prompt).toContain(
      "When one owner request changes multiple canonical facets at once (for example identity plus role plus tone), update every relevant canonical surface in the same turn. Do not stop after a partial mutation.",
    );
    expect(prompt).toContain(
      "After a durable identity/persona mutation, reconcile stale self-references across the affected canonical files so they agree with the newest canon.",
    );
    expect(prompt).toContain(
      "Do not reject owner-directed persona changes just because existing files mention OpenClaw or runtime framework details.",
    );
    expect(prompt).toContain(
      "Rules about how future edits, testing, review, safety, or workspace behavior should operate are core workspace rules and belong in AGENTS.md, not TOOLS.md.",
    );
    expect(prompt).toContain(
      "If the user is changing how replies should sound or feel, prefer SOUL.md over squeezing that instruction into IDENTITY metadata.",
    );
    expect(prompt).toContain(
      "When the user is asking you to add, store, change, or remove a durable rule/persona/identity instruction, do the workspace edit itself.",
    );
    expect(prompt).toContain(
      "For short canonical markdown files such as `IDENTITY.md`, `SOUL.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md`, default to `write` after `read`",
    );
    expect(prompt).toContain(
      "If a `edit` call fails because text did not match, immediately use `read` on that same path before retrying. Do not invent `old_string` from memory.",
    );
    expect(prompt).toContain(
      "If a helper search/read attempt fails while you are making a durable workspace change, recover by reading the target file directly and finish the edit.",
    );
    expect(prompt).toContain(
      "If multiple surfaces are affected, update each canonical file that holds part of the requested state and keep them consistent with each other.",
    );
  });
});
