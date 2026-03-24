import { stripAssistantInternalScaffolding } from "../../shared/text/assistant-visible-text.js";
import type { ReplyPayload } from "../types.js";

const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
const ROLE_TURN_MARKER_RE = /\b(?:user|system|assistant)\s*:\s*$/gm;
const LEAK_MARKER_RE =
  /(?:^|\n)\s*(?:Oops[.!…]*|(?:This\s*(?:\n|$))?(?:Given the conversation, we need to answer:|We need to answer:|The user asks\b|Provide concise answer\b|Reasoning:\s*))/i;
const STANDALONE_OOPS_RE = /(?:^|\n)\s*Oops[.!…]*\s*/gi;
const STANDALONE_THIS_RE = /(?:^|\n)\s*This\s*(?=\n|$)/gi;
const PLANNER_SENTENCE_RES = [
  /Given the conversation, we need to answer:.*?(?:(?:[.!?]["”']?)\s+|$)/gis,
  /We need to answer:.*?(?:(?:[.!?]["”']?)\s+|$)/gis,
  /The user asks.*?(?:(?:[.!?]["”']?)\s+|$)/gis,
  /We already see that.*?(?:(?:[.!?]["”']?)\s+|$)/gis,
  /So we can answer.*?(?:(?:[.!?]["”']?)\s+|$)/gis,
  /Provide concise answer(?:\s+in\s+[A-Za-z ]+)?\.?\s*/gis,
];
const CLEANUP_LEAD_RE = /^(?:The answer:\s*)/i;
const HEAVY_REDACTION_RE = /(?:\*{3,}|\.{3,}|…{2,}|`[^`\n]*\.\.\.[^`\n]*`)/;

function cleanupPlannerTail(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(STANDALONE_OOPS_RE, "\n");
  cleaned = cleaned.replace(STANDALONE_THIS_RE, "\n");
  for (const pattern of PLANNER_SENTENCE_RES) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned
    .replace(CLEANUP_LEAD_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasHeavyRedactionArtifacts(text: string): boolean {
  return HEAVY_REDACTION_RE.test(text);
}

export function sanitizeExternalReplyText(text: string): string {
  if (!text) {
    return text;
  }

  let cleaned = stripAssistantInternalScaffolding(text);
  cleaned = cleaned.replace(INTERNAL_SEPARATOR_RE, "");
  cleaned = cleaned.replace(ASSISTANT_ROLE_MARKER_RE, "");
  cleaned = cleaned.replace(ROLE_TURN_MARKER_RE, "");

  const leakIndex = cleaned.search(LEAK_MARKER_RE);
  if (leakIndex > 0) {
    const prefix = cleaned.slice(0, leakIndex).trim();
    const suffixCandidate = cleanupPlannerTail(cleaned.slice(leakIndex));
    cleaned =
      suffixCandidate &&
      (!prefix || hasHeavyRedactionArtifacts(prefix) || suffixCandidate.length >= prefix.length)
        ? suffixCandidate
        : prefix;
  } else {
    cleaned = cleanupPlannerTail(cleaned);
  }

  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

export function sanitizeExternalReplyPayload(payload: ReplyPayload): ReplyPayload {
  if (!payload.text) {
    return payload;
  }
  return {
    ...payload,
    text: sanitizeExternalReplyText(payload.text),
  };
}
