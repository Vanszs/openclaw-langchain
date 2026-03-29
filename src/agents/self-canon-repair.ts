import fs from "node:fs/promises";
import path from "node:path";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadIdentityFromFile } from "./identity-file.js";
import { DEFAULT_IDENTITY_FILENAME, DEFAULT_SOUL_FILENAME } from "./workspace.js";

export type SelfCanonSnapshot = {
  identityPath: string;
  soulPath: string;
  identityContent?: string;
  soulContent?: string;
  identityName?: string;
};

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export async function readSelfCanonSnapshot(workspaceDir: string): Promise<SelfCanonSnapshot> {
  const identityPath = path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME);
  const soulPath = path.join(workspaceDir, DEFAULT_SOUL_FILENAME);
  const [identityContent, soulContent] = await Promise.all([
    readOptionalFile(identityPath),
    readOptionalFile(soulPath),
  ]);
  const identityName = loadIdentityFromFile(identityPath)?.name?.trim();
  return {
    identityPath,
    soulPath,
    identityContent,
    soulContent,
    identityName,
  };
}

export function didSelfCanonChange(before: SelfCanonSnapshot, after: SelfCanonSnapshot): boolean {
  return (
    before.identityContent !== after.identityContent || before.soulContent !== after.soulContent
  );
}

export function shouldRunSelfCanonRepair(
  before: SelfCanonSnapshot,
  after: SelfCanonSnapshot,
): boolean {
  if (!didSelfCanonChange(before, after)) {
    return false;
  }

  const identityChanged = before.identityContent !== after.identityContent;
  const soulChanged = before.soulContent !== after.soulContent;
  if (!identityChanged && !soulChanged) {
    return false;
  }

  if (!after.soulContent) {
    return false;
  }

  if (identityChanged && !soulChanged) {
    return true;
  }

  const previousName = before.identityName?.trim().toLowerCase();
  const currentName = after.identityName?.trim().toLowerCase();
  if (!previousName || !currentName || previousName === currentName) {
    return false;
  }

  const identityLower = after.identityContent?.toLowerCase() ?? "";
  const soulLower = after.soulContent.toLowerCase();
  const identityStillMentionsPreviousName =
    identityLower.includes(previousName) && !identityLower.includes(`**name:** ${previousName}`);
  const soulStillMentionsPreviousName = soulLower.includes(previousName);
  return (
    (identityStillMentionsPreviousName && identityLower.includes(currentName)) ||
    (soulStillMentionsPreviousName && !soulLower.includes(currentName))
  );
}

export function buildSelfCanonRepairPrompt(params: {
  before: SelfCanonSnapshot;
  after: SelfCanonSnapshot;
}): string {
  const lines = [
    "## Internal Self-Canon Reconciliation",
    "This is an internal follow-up after a durable self-canon mutation.",
    "Read IDENTITY.md and SOUL.md from the current workspace before doing anything else.",
    "Treat the newest on-disk value from any canonical file that changed in the previous turn as authoritative while you reconcile stale references elsewhere.",
  ];
  if (
    params.before.identityName &&
    params.after.identityName &&
    params.before.identityName !== params.after.identityName
  ) {
    lines.push(
      `Recent canonical change: IDENTITY.md name changed from "${params.before.identityName}" to "${params.after.identityName}". Do not revert "${params.after.identityName}" while reconciling other files.`,
    );
  } else if (params.before.identityContent !== params.after.identityContent) {
    lines.push(
      "Recent canonical change: IDENTITY.md changed in the previous turn. Use its newest on-disk contents as the identity anchor while reconciling other files.",
    );
  }
  if (params.before.soulContent !== params.after.soulContent) {
    lines.push(
      "Recent canonical change: SOUL.md changed in the previous turn. Preserve its newest on-disk persona guidance unless another newly changed canonical file is more specific for that facet.",
    );
  }
  lines.push(
    "If the files disagree about your current name, role, relationship to the owner, or tone, update the necessary canonical file(s) so the newest canon is internally consistent.",
    "Do not touch unrelated files.",
    "Do not send messages, schedule anything, or perform external side effects.",
    `When reconciliation is complete, reply with ONLY: ${SILENT_REPLY_TOKEN}`,
  );
  return lines.join("\n");
}
