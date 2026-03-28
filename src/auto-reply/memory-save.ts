import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { storeDocsKbRecord } from "../memory/docs-kb-store.js";
import type { MemoryDomain } from "../memory/types.js";
import { upsertUserMemoryFact } from "../memory/user-memory-store.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { findCueTokenIndex, findPhraseSpan, hasCueToken, tokenizeCueText } from "./cue-matcher.js";
import {
  tokenizeSemanticText,
  findSemanticConceptIndex,
  hasSemanticConcept,
  sliceSemanticTextFromTokenIndex,
  type SemanticToken,
} from "./semantic-concepts.js";
import type { MsgContext } from "./templating.js";

export type RetrievalSaveContext = {
  domain: MemoryDomain | "web_search";
  note: string;
};

export type DeterministicSaveAction =
  | {
      reply: string;
    }
  | undefined;

type UserFactDraft = {
  namespace: string;
  key: string;
  value: string;
};

const DOC_SAVE_TOKENS = new Set(["save", "simpan"]);
const DOC_SUBJECT_TOKENS = new Set([
  "docs",
  "documentation",
  "document",
  "dokumen",
  "article",
  "artikel",
  "result",
  "hasil",
  "research",
  "riset",
  "reference",
  "referensi",
  "knowledge",
  "file",
  "pdf",
  "gambar",
  "image",
  "screenshot",
]);
const USER_MEMORY_ACTION_TOKENS = new Set([
  "ingat",
  "remember",
  "catat",
  "simpan",
  "save",
  "store",
  "persist",
]);
const AMBIGUOUS_SAVE_TOKENS = new Set(["itu", "ini", "this", "those"]);
const AMBIGUOUS_SAVE_PHRASES = [
  ["semua", "informasi"],
  ["informasi", "tersebut"],
  ["hasil", "tersebut"],
  ["hasil", "ini"],
  ["semua", "hasil"],
  ["all", "of", "that"],
  ["all", "that"],
] as const;
const USER_MEMORY_UPDATE_TOKENS = new Set(["ganti", "ubah", "update", "replace"]);
const LEADING_VALUE_SKIP_TOKENS = new Set([
  "adalah",
  "is",
  "itu",
  "yang",
  "paling",
  "itu",
  "sekarang",
]);
const KNOWLEDGE_SOURCE_DOC_TOKENS = new Set([
  "repo",
  "docs",
  "documentation",
  "manual",
  "reference",
  "referensi",
]);
const KNOWLEDGE_SOURCE_WEB_TOKENS = new Set(["web", "search", "research", "riset"]);
const OWNER_PROFILE_SEMANTIC_LEXICON = {
  self: ["saya", "aku", "gue", "gw", "me", "my", "i"],
  memory_action: [
    "ingat",
    "remember",
    "catat",
    "simpan",
    "save",
    "store",
    "persist",
    "ingat kalau",
    "remember that",
    "remember this about me",
  ],
  update_action: ["ganti", "ubah", "update", "replace"],
  field_name: ["nama", "name", "bernama", "named", "nama saya", "my name"],
  field_full: ["lengkap", "full"],
  field_nickname: [
    "nickname",
    "panggilan",
    "nick",
    "panggil",
    "call",
    "called",
    "panggil saya",
    "call me",
  ],
  field_allergy: ["alergi", "allergic"],
  field_database: ["database", "db"],
  field_framework: ["framework"],
  field_editor: ["editor"],
  field_invoice: ["invoice", "faktur"],
  field_ticket: ["ticket", "tiket"],
  field_code: ["code", "kode"],
  field_favorite: ["favorit", "favorite", "suka", "preferred"],
  copula: ["adalah", "ialah", "is", "am", "bernama", "named", "called", "sebagai", "as"],
  update_target: ["jadi", "to", "ke", "menjadi"],
  about_self: ["tentang saya", "tentang aku", "tentang gue", "tentang gw", "about me"],
} satisfies Record<string, readonly string[]>;

const OWNER_PROFILE_FIELD_CONCEPTS = [
  "field_name",
  "field_nickname",
  "field_allergy",
  "field_database",
  "field_framework",
  "field_editor",
  "field_invoice",
  "field_ticket",
  "field_code",
] as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimLeadingValuePreamble(text: string): string {
  let next = normalizeWhitespace(text);
  while (next) {
    const tokens = tokenizeCueText(next);
    const first = tokens[0];
    if (!first || !LEADING_VALUE_SKIP_TOKENS.has(first.value)) {
      return next;
    }
    next = normalizeWhitespace(next.slice(first.end));
  }
  return next;
}

function isExplicitDocSave(query: string): boolean {
  const tokens = tokenizeCueText(query);
  return hasCueToken(tokens, DOC_SAVE_TOKENS) && hasCueToken(tokens, DOC_SUBJECT_TOKENS);
}

function isExplicitUserMemoryIntent(query: string): boolean {
  const semanticTokens = tokenizeOwnerProfileSemantics(query);
  if (!hasSemanticConcept(semanticTokens, "self")) {
    return false;
  }
  const hasFieldConcept = OWNER_PROFILE_FIELD_CONCEPTS.some((concept) =>
    hasSemanticConcept(semanticTokens, concept),
  );
  const hasIdentityStatement =
    (hasSemanticConcept(semanticTokens, "field_name") ||
      hasSemanticConcept(semanticTokens, "field_nickname")) &&
    hasSemanticConcept(semanticTokens, "copula");
  const hasExplicitMutation =
    hasSemanticConcept(semanticTokens, "memory_action") ||
    hasSemanticConcept(semanticTokens, "update_action");
  if (
    hasExplicitMutation &&
    (hasFieldConcept || hasSemanticConcept(semanticTokens, "about_self"))
  ) {
    return true;
  }
  if (hasIdentityStatement) {
    return true;
  }
  return deriveFactFromQuery(query) !== undefined;
}

function getRelevantSourceText(params: {
  ctx: MsgContext;
  attachmentRetrievalNote?: string;
  retrievalContext?: RetrievalSaveContext;
}): string | undefined {
  const historyBody = Array.isArray(params.ctx.InboundHistory)
    ? params.ctx.InboundHistory.at(-1)?.body
    : undefined;
  return [
    params.ctx.ReplyToBody,
    historyBody,
    params.ctx.ThreadHistoryBody,
    params.attachmentRetrievalNote,
    params.retrievalContext?.note,
  ]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
}

function extractInlineKnowledgeContent(query: string): string | undefined {
  const trimmed = normalizeWhitespace(query);
  if (!trimmed) {
    return undefined;
  }
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex >= 0) {
    const tail = normalizeWhitespace(trimmed.slice(colonIndex + 1));
    if (tail) {
      return tail;
    }
  }
  const tokens = tokenizeCueText(trimmed);
  const saveIndex = findCueTokenIndex(tokens, DOC_SAVE_TOKENS);
  const subjectIndex = findCueTokenIndex(tokens, DOC_SUBJECT_TOKENS, {
    startIndex: Math.max(0, saveIndex),
  });
  const stripped =
    subjectIndex >= 0 ? normalizeWhitespace(trimmed.slice(tokens[subjectIndex].end)) : trimmed;
  if (!stripped) {
    return undefined;
  }
  const strippedTokens = tokenizeCueText(stripped);
  if (
    strippedTokens.length > 0 &&
    (hasCueToken(strippedTokens, AMBIGUOUS_SAVE_TOKENS) ||
      AMBIGUOUS_SAVE_PHRASES.some((phrase) => findPhraseSpan(strippedTokens, phrase) !== undefined))
  ) {
    return undefined;
  }
  return stripped;
}

function buildProvenance(ctx: MsgContext) {
  const directProvider = normalizeMessageChannel(ctx.Provider);
  const directSurface = normalizeMessageChannel(ctx.Surface);
  const originatingChannel = normalizeMessageChannel(ctx.OriginatingChannel);
  const provider =
    directProvider && directProvider !== INTERNAL_MESSAGE_CHANNEL
      ? directProvider
      : originatingChannel;
  const surface =
    directSurface && directSurface !== INTERNAL_MESSAGE_CHANNEL
      ? directSurface
      : originatingChannel;
  const source = provider ?? surface ?? "auto-reply";
  return {
    source,
    sessionKey: ctx.SessionKey,
    messageId: ctx.MessageSidFull ?? ctx.MessageSid,
    provider,
    surface,
    senderId: ctx.SenderId,
    senderName: ctx.SenderName,
    senderUsername: ctx.SenderUsername,
    channelId: ctx.NativeChannelId ?? ctx.OriginatingTo,
  };
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "note";
}

function buildKnowledgeTitle(query: string, sourceText: string): string {
  const firstLine = sourceText
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (firstLine) {
    return firstLine.slice(0, 120);
  }
  return normalizeWhitespace(query).slice(0, 120) || "Saved knowledge note";
}

function inferKnowledgeSourceType(
  query: string,
  attachmentRetrievalNote?: string,
): "repo" | "docs" | "web" | "attachment" | "manual-note" {
  const normalized = query.toLowerCase();
  const tokens = tokenizeCueText(normalized);
  if (attachmentRetrievalNote?.trim()) {
    return "attachment";
  }
  if (tokens.some((token) => token.value === "repo")) {
    return "repo";
  }
  if (hasCueToken(tokens, KNOWLEDGE_SOURCE_DOC_TOKENS)) {
    return "docs";
  }
  if (
    hasCueToken(tokens, KNOWLEDGE_SOURCE_WEB_TOKENS) ||
    findPhraseSpan(tokens, ["hasil", "riset"]) !== undefined
  ) {
    return "web";
  }
  return "manual-note";
}

function tokenizeOwnerProfileSemantics(query: string): SemanticToken[] {
  return tokenizeSemanticText(query, OWNER_PROFILE_SEMANTIC_LEXICON);
}

function findLastSemanticConceptIndex(
  tokens: SemanticToken[],
  concepts: readonly string[],
  startIndex = 0,
): number {
  let best = -1;
  for (const concept of concepts) {
    const index = findSemanticConceptIndex(tokens, concept, {
      fromEnd: true,
      startIndex,
    });
    if (index > best) {
      best = index;
    }
  }
  return best;
}

function extractSemanticValue(params: {
  text: string;
  tokens: SemanticToken[];
  fieldConcepts: readonly string[];
  preferUpdateTarget?: boolean;
  allowSelfAsValueAnchor?: boolean;
  secondaryAnchorConcepts?: readonly string[];
}): string | undefined {
  const fieldIndex = findLastSemanticConceptIndex(params.tokens, params.fieldConcepts);
  if (fieldIndex < 0) {
    return undefined;
  }

  let valueStartIndex = fieldIndex + 1;
  const secondaryAnchorIndex = findLastSemanticConceptIndex(
    params.tokens,
    params.secondaryAnchorConcepts ?? [],
    fieldIndex + 1,
  );
  if (secondaryAnchorIndex > fieldIndex) {
    valueStartIndex = secondaryAnchorIndex + 1;
  }
  if (params.allowSelfAsValueAnchor) {
    const selfIndex = findSemanticConceptIndex(params.tokens, "self", {
      fromEnd: true,
      startIndex: fieldIndex + 1,
    });
    if (selfIndex > fieldIndex) {
      valueStartIndex = selfIndex + 1;
    }
  }
  if (params.preferUpdateTarget) {
    const updateTargetIndex = findSemanticConceptIndex(params.tokens, "update_target", {
      fromEnd: true,
      startIndex: fieldIndex + 1,
    });
    if (updateTargetIndex > fieldIndex) {
      valueStartIndex = updateTargetIndex + 1;
    }
  }

  const copulaIndex = findSemanticConceptIndex(params.tokens, "copula", {
    fromEnd: true,
    startIndex: fieldIndex + 1,
  });
  if (copulaIndex > fieldIndex) {
    valueStartIndex = copulaIndex + 1;
  }

  const rawValue = sliceSemanticTextFromTokenIndex(params.text, params.tokens, valueStartIndex);
  const value = rawValue ? trimLeadingValuePreamble(rawValue) : undefined;
  return value?.trim() ? value : undefined;
}

function extractSemanticPreferredName(params: {
  text: string;
  tokens: SemanticToken[];
}): string | undefined {
  if (!hasSemanticConcept(params.tokens, "field_nickname")) {
    return undefined;
  }
  const callIndex = findSemanticConceptIndex(params.tokens, "field_nickname");
  if (callIndex < 0) {
    return undefined;
  }
  const selfIndex = findSemanticConceptIndex(params.tokens, "self", { startIndex: callIndex });
  const anchorIndex = selfIndex > callIndex ? selfIndex + 1 : callIndex + 1;
  const rawValue = sliceSemanticTextFromTokenIndex(params.text, params.tokens, anchorIndex);
  const value = rawValue ? trimLeadingValuePreamble(rawValue) : undefined;
  return value?.trim() ? value : undefined;
}

function buildNoteFact(statement: string): UserFactDraft {
  const noteHash = crypto
    .createHash("sha1")
    .update(statement.toLowerCase())
    .digest("hex")
    .slice(0, 8);
  return {
    namespace: "profile",
    key: `note.${noteHash}`,
    value: statement,
  };
}

function deriveFactFromQuery(query: string): UserFactDraft | undefined {
  const normalized = normalizeWhitespace(query);
  const lowered = normalized.toLowerCase();
  const tokens = tokenizeCueText(lowered);
  const semanticTokens = tokenizeOwnerProfileSemantics(lowered);
  const preferUpdateTarget =
    hasCueToken(tokens, USER_MEMORY_UPDATE_TOKENS) ||
    hasSemanticConcept(semanticTokens, "update_action");

  const fullNameValue = extractSemanticValue({
    text: normalized,
    tokens: semanticTokens,
    fieldConcepts: ["field_name"],
    preferUpdateTarget,
    allowSelfAsValueAnchor: true,
  });
  if (
    fullNameValue &&
    hasSemanticConcept(semanticTokens, "self") &&
    !hasSemanticConcept(semanticTokens, "field_nickname") &&
    !hasSemanticConcept(semanticTokens, "field_favorite")
  ) {
    return {
      namespace: "profile",
      key: "name.full",
      value: fullNameValue,
    };
  }

  const nicknameValue =
    extractSemanticValue({
      text: normalized,
      tokens: semanticTokens,
      fieldConcepts: ["field_nickname"],
      preferUpdateTarget,
      allowSelfAsValueAnchor: true,
      secondaryAnchorConcepts: ["field_name"],
    }) ?? extractSemanticPreferredName({ text: normalized, tokens: semanticTokens });
  if (nicknameValue && hasSemanticConcept(semanticTokens, "self")) {
    return {
      namespace: "profile",
      key: "nickname",
      value: nicknameValue,
    };
  }

  const allergyValue = extractSemanticValue({
    text: normalized,
    tokens: semanticTokens,
    fieldConcepts: ["field_allergy"],
    preferUpdateTarget,
  });
  if (allergyValue && hasSemanticConcept(semanticTokens, "self")) {
    return {
      namespace: "profile",
      key: "allergy",
      value: allergyValue,
    };
  }

  const favoriteFields: Array<{
    concept: string;
    namespace: string;
    key: string;
  }> = [
    { concept: "field_database", namespace: "preferences", key: "database.favorite" },
    { concept: "field_framework", namespace: "preferences", key: "framework.favorite" },
    { concept: "field_editor", namespace: "preferences", key: "editor.favorite" },
  ];
  for (const field of favoriteFields) {
    if (!hasSemanticConcept(semanticTokens, field.concept)) {
      continue;
    }
    if (!hasSemanticConcept(semanticTokens, "field_favorite")) {
      continue;
    }
    const value = extractSemanticValue({
      text: normalized,
      tokens: semanticTokens,
      fieldConcepts: [field.concept],
      preferUpdateTarget,
      allowSelfAsValueAnchor: true,
      secondaryAnchorConcepts: ["field_favorite"],
    });
    if (!value || !hasSemanticConcept(semanticTokens, "self")) {
      continue;
    }
    return {
      namespace: field.namespace,
      key: field.key,
      value,
    };
  }

  if (
    hasSemanticConcept(semanticTokens, "memory_action") &&
    hasSemanticConcept(semanticTokens, "self")
  ) {
    const rememberIndex = findSemanticConceptIndex(semanticTokens, "memory_action", {
      fromEnd: true,
    });
    let statement =
      rememberIndex >= 0
        ? (sliceSemanticTextFromTokenIndex(normalized, semanticTokens, rememberIndex + 1) ??
          normalized)
        : normalized;
    const statementTokens = tokenizeOwnerProfileSemantics(statement);
    const aboutIndex = findSemanticConceptIndex(statementTokens, "about_self");
    if (aboutIndex === 0) {
      statement =
        sliceSemanticTextFromTokenIndex(statement, statementTokens, aboutIndex + 1) ?? statement;
      statement = normalizeWhitespace(statement);
    }
    if (statement) {
      return buildNoteFact(statement);
    }
  }

  return undefined;
}

function deriveFactFromSourceText(params: {
  query: string;
  sourceText?: string;
}): UserFactDraft | undefined {
  const query = normalizeWhitespace(params.query).toLowerCase();
  const queryTokens = tokenizeOwnerProfileSemantics(query);
  const sourceText = params.sourceText?.trim();
  if (!sourceText) {
    return undefined;
  }

  const invoiceMatch = sourceText.match(
    /\binvoice(?:\s+number|\s+no\.?|\s*#)?\s*[:#-]?\s*([a-z0-9][a-z0-9-]{2,})\b/i,
  );
  if (invoiceMatch?.[1] && hasSemanticConcept(queryTokens, "field_invoice")) {
    return {
      namespace: "reference",
      key: "invoice.number",
      value: invoiceMatch[1].trim(),
    };
  }

  const ticketMatch = sourceText.match(
    /\b(?:ticket|tiket)(?:\s+number|\s+no\.?|\s*#)?\s*[:#-]?\s*([a-z0-9][a-z0-9-]{2,})\b/i,
  );
  if (ticketMatch?.[1] && hasSemanticConcept(queryTokens, "field_ticket")) {
    return {
      namespace: "reference",
      key: "ticket.number",
      value: ticketMatch[1].trim(),
    };
  }

  const codeMatch = sourceText.match(
    /\b(?:code|kode)(?:\s+number|\s+no\.?|\s*#)?\s*[:#-]?\s*([a-z0-9][a-z0-9-]{2,})\b/i,
  );
  if (codeMatch?.[1] && hasSemanticConcept(queryTokens, "field_code")) {
    return {
      namespace: "reference",
      key: "code.value",
      value: codeMatch[1].trim(),
    };
  }

  return undefined;
}

function isAmbiguousSave(params: {
  query: string;
  retrievalContext?: RetrievalSaveContext;
  sourceText?: string;
}): boolean {
  const normalized = normalizeWhitespace(params.query);
  if (isExplicitDocSave(normalized) || isExplicitUserMemoryIntent(normalized)) {
    return false;
  }
  const tokens = tokenizeCueText(normalized);
  if (!hasCueToken(tokens, USER_MEMORY_ACTION_TOKENS) && !hasCueToken(tokens, DOC_SAVE_TOKENS)) {
    return false;
  }
  if (
    !(
      hasCueToken(tokens, AMBIGUOUS_SAVE_TOKENS) ||
      AMBIGUOUS_SAVE_PHRASES.some((phrase) => findPhraseSpan(tokens, phrase) !== undefined)
    )
  ) {
    return false;
  }
  return (
    params.retrievalContext?.domain === "docs_kb" ||
    params.retrievalContext?.domain === "web_search" ||
    params.retrievalContext?.domain === "history" ||
    Boolean(params.sourceText)
  );
}

export async function maybeHandleDeterministicMemorySave(params: {
  ctx: MsgContext;
  cfg?: OpenClawConfig;
  query: string;
  workspaceDir: string;
  attachmentRetrievalNote?: string;
  retrievalContext?: RetrievalSaveContext;
}): Promise<DeterministicSaveAction> {
  const query = normalizeWhitespace(params.query);
  if (!query) {
    return undefined;
  }
  const sourceText = getRelevantSourceText(params);
  const inlineKnowledgeText = extractInlineKnowledgeContent(query);
  const docsSaveText = sourceText ?? inlineKnowledgeText;

  if (
    isAmbiguousSave({
      query,
      retrievalContext: params.retrievalContext,
      sourceText: sourceText ?? inlineKnowledgeText,
    })
  ) {
    return {
      reply:
        "Perlu klarifikasi sebelum menyimpan: simpan sebagai knowledge dokumen, atau ingat sebagai fakta tentang Anda?",
    };
  }

  if (isExplicitDocSave(query)) {
    if (!docsSaveText) {
      return {
        reply:
          "Saya butuh teks atau dokumen target untuk disimpan. Balas sambil reply ke hasil yang dimaksud, atau kirim ulang teks/dokumennya.",
      };
    }
    const title = buildKnowledgeTitle(query, docsSaveText);
    const record = await storeDocsKbRecord({
      workspaceDir: params.workspaceDir,
      title,
      body: docsSaveText,
      sourceType: inferKnowledgeSourceType(query, params.attachmentRetrievalNote),
      provenance: buildProvenance(params.ctx),
      docId: slugify(title),
    });
    return {
      reply: `Tersimpan ke knowledge base: ${record.record.title} (v${record.record.version}).`,
    };
  }

  if (isExplicitUserMemoryIntent(query)) {
    const auth = params.cfg
      ? resolveCommandAuthorization({
          ctx: params.ctx,
          cfg: params.cfg,
          commandAuthorized: true,
        })
      : undefined;
    const canWriteOwnerProfile =
      auth?.senderIsOwnerExplicit === true && params.ctx.ChatType === "direct";
    if (!canWriteOwnerProfile) {
      return {
        reply:
          "Owner profile hanya bisa ditulis oleh owner dari chat direct. Permintaan ini tidak saya simpan.",
      };
    }
    const fact = deriveFactFromSourceText({ query, sourceText }) ?? deriveFactFromQuery(query);
    if (!fact) {
      return {
        reply:
          "Saya bisa simpan ke user memory kalau faktanya eksplisit. Contoh: `ingat database favorit saya DuckDB` atau `ganti framework favorit saya dari Next.js ke Astro`.",
      };
    }
    const result = await upsertUserMemoryFact({
      workspaceDir: params.workspaceDir,
      namespace: fact.namespace,
      key: fact.key,
      value: fact.value,
      provenance: buildProvenance(params.ctx),
    });
    const supersededText = result.superseded ? " Record lama disupersede." : "";
    return {
      reply: `Tersimpan ke user memory: ${fact.key} = ${fact.value}.${supersededText}`,
    };
  }

  return undefined;
}
