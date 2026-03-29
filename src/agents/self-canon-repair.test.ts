import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  buildSelfCanonRepairPrompt,
  didSelfCanonChange,
  shouldRunSelfCanonRepair,
  type SelfCanonSnapshot,
} from "./self-canon-repair.js";

function makeSnapshot(overrides: Partial<SelfCanonSnapshot> = {}): SelfCanonSnapshot {
  return {
    identityPath: "/tmp/IDENTITY.md",
    soulPath: "/tmp/SOUL.md",
    identityContent: "# identity\n- **Name:** hypatia\n",
    soulContent: "You are hypatia, the owner's personal maid.",
    identityName: "hypatia",
    ...overrides,
  };
}

describe("self canon repair", () => {
  it("detects when neither self canon file changed", () => {
    const before = makeSnapshot();
    const after = makeSnapshot();

    expect(didSelfCanonChange(before, after)).toBe(false);
    expect(shouldRunSelfCanonRepair(before, after)).toBe(false);
  });

  it("requests repair when identity changed but soul stayed untouched", () => {
    const before = makeSnapshot();
    const after = makeSnapshot({
      identityContent: "# identity\n- **Name:** Lyra\n",
      identityName: "Lyra",
    });

    expect(didSelfCanonChange(before, after)).toBe(true);
    expect(shouldRunSelfCanonRepair(before, after)).toBe(true);
  });

  it("requests repair when soul still mentions the previous name", () => {
    const before = makeSnapshot();
    const after = makeSnapshot({
      identityContent: "# identity\n- **Name:** Lyra\n",
      soulContent: "You are hypatia, the owner's personal maid.",
      identityName: "Lyra",
    });

    expect(shouldRunSelfCanonRepair(before, after)).toBe(true);
  });

  it("skips repair when soul already matches the renamed identity", () => {
    const before = makeSnapshot();
    const after = makeSnapshot({
      identityContent: "# identity\n- **Name:** Lyra\n",
      soulContent: "You are Lyra, the owner's personal maid.",
      identityName: "Lyra",
    });

    expect(shouldRunSelfCanonRepair(before, after)).toBe(false);
  });

  it("requests another repair pass when identity body still mentions the previous name", () => {
    const before = makeSnapshot();
    const after = makeSnapshot({
      identityContent:
        "# identity\n- **Name:** Lyra\n\nCurrent baseline:\n- Hypatia is the owner's personal maid.\n",
      soulContent: "You are Lyra, the owner's personal maid.",
      identityName: "Lyra",
    });

    expect(shouldRunSelfCanonRepair(before, after)).toBe(true);
  });

  it("builds a silent internal reconciliation prompt", () => {
    const prompt = buildSelfCanonRepairPrompt({
      before: makeSnapshot(),
      after: makeSnapshot({
        identityContent: "# identity\n- **Name:** Lyra\n",
        identityName: "Lyra",
      }),
    });

    expect(prompt).toContain("## Internal Self-Canon Reconciliation");
    expect(prompt).toContain("Read IDENTITY.md and SOUL.md");
    expect(prompt).toContain("Treat the newest on-disk value");
    expect(prompt).toContain('IDENTITY.md name changed from "hypatia" to "Lyra"');
    expect(prompt).toContain('Do not revert "Lyra"');
    expect(prompt).toContain("Do not touch unrelated files.");
    expect(prompt).toContain(`reply with ONLY: ${SILENT_REPLY_TOKEN}`);
  });
});
