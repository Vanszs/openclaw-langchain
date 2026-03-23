import crypto from "node:crypto";
import { storeDocsKbRecord } from "../memory/docs-kb-store.js";
import type { MemoryDomain } from "../memory/types.js";
import { upsertUserMemoryFact } from "../memory/user-memory-store.js";
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

const EXPLICIT_DOC_SAVE_RE =
  /\b(save|simpan)\b.*\b(docs?|documentation|document|dokumen|article|artikel|result|hasil|research|riset|reference|referensi|knowledge|file|pdf|gambar|image|screenshot)\b/i;
const EXPLICIT_USER_MEMORY_RE =
  /\b(ingat|remember|catat|simpan(?:kan)?\s+bahwa|remember\s+this\s+about\s+me)\b/i;
const AMBIGUOUS_SAVE_RE =
  /\b(save|simpan|remember|ingat)\b.*\b(semua informasi|informasi tersebut|hasil tersebut|hasil ini|itu|this|those|semua hasil|all of that|all that)\b/i;
const SELF_REFERENCE_RE = /\b(saya|aku|gue|gw|me|my)\b/i;
const USER_MEMORY_UPDATE_RE = /\b(ganti|ubah|update|replace)\b/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
  const stripped = normalizeWhitespace(
    trimmed.replace(
      /\b(save|simpan)\b.*\b(docs?|documentation|document|dokumen|article|artikel|result|hasil|research|riset|reference|referensi|knowledge|file|pdf|gambar|image|screenshot)\b/gi,
      " ",
    ),
  );
  if (!stripped) {
    return undefined;
  }
  if (/^(this|itu|ini|those|all that|all of that)$/i.test(stripped)) {
    return undefined;
  }
  return stripped;
}

function buildProvenance(ctx: MsgContext) {
  return {
    source: ctx.Provider ?? ctx.Surface ?? "auto-reply",
    sessionKey: ctx.SessionKey,
    messageId: ctx.MessageSidFull ?? ctx.MessageSid,
    provider: ctx.Provider,
    surface: ctx.Surface,
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
  if (attachmentRetrievalNote?.trim()) {
    return "attachment";
  }
  if (/\brepo\b/.test(normalized)) {
    return "repo";
  }
  if (/\b(docs?|documentation|manual|reference|referensi)\b/.test(normalized)) {
    return "docs";
  }
  if (/\b(web|search|hasil\s+riset|research)\b/.test(normalized)) {
    return "web";
  }
  return "manual-note";
}

function deriveFactFromQuery(query: string): UserFactDraft | undefined {
  const normalized = normalizeWhitespace(query);
  const lowered = normalized.toLowerCase();

  const allergyMatch = normalized.match(/\b(?:saya|aku|gue|gw|i)\s+alergi\s+(.+)$/i);
  if (allergyMatch?.[1]) {
    return {
      namespace: "profile",
      key: "allergy",
      value: allergyMatch[1].trim(),
    };
  }

  const nicknameMatch = normalized.match(
    /\b(?:nama\s+panggilan|nickname)\s+(?:saya|aku|gue|gw|my)\s*(?:adalah|is|itu|=)?\s+(.+)$/i,
  );
  if (nicknameMatch?.[1]) {
    return {
      namespace: "profile",
      key: "nickname",
      value: nicknameMatch[1].trim(),
    };
  }

  const updatePatterns: Array<{ re: RegExp; namespace: string; key: string }> = [
    {
      re: /\b(?:ganti|ubah|update|replace)\s+framework\s+favorit\s+(?:saya|aku|gue|gw|my)\s+(?:dari|from)\s+.+?\s+(?:jadi|to)\s+(.+)$/i,
      namespace: "preferences",
      key: "framework.favorite",
    },
    {
      re: /\b(?:ganti|ubah|update|replace)\s+database\s+favorit\s+(?:saya|aku|gue|gw|my)\s+(?:dari|from)\s+.+?\s+(?:jadi|to)\s+(.+)$/i,
      namespace: "preferences",
      key: "database.favorite",
    },
    {
      re: /\b(?:ganti|ubah|update|replace)\s+editor\s+favorit\s+(?:saya|aku|gue|gw|my)\s+(?:dari|from)\s+.+?\s+(?:jadi|to)\s+(.+)$/i,
      namespace: "preferences",
      key: "editor.favorite",
    },
  ];
  for (const pattern of updatePatterns) {
    const match = normalized.match(pattern.re);
    if (match?.[1]) {
      return {
        namespace: pattern.namespace,
        key: pattern.key,
        value: match[1].trim(),
      };
    }
  }

  const favoritePatterns: Array<{ re: RegExp; namespace: string; key: string }> = [
    {
      re: /\b(?:database|db)\s+favorit\s+(?:saya|aku|gue|gw|my)\s*(?:adalah|is|itu|=)?\s+(.+)$/i,
      namespace: "preferences",
      key: "database.favorite",
    },
    {
      re: /\bframework\s+favorit\s+(?:saya|aku|gue|gw|my)\s*(?:adalah|is|itu|=)?\s+(.+)$/i,
      namespace: "preferences",
      key: "framework.favorite",
    },
    {
      re: /\beditor\s+favorit\s+(?:saya|aku|gue|gw|my)\s*(?:adalah|is|itu|=)?\s+(.+)$/i,
      namespace: "preferences",
      key: "editor.favorite",
    },
  ];
  for (const pattern of favoritePatterns) {
    const match = normalized.match(pattern.re);
    if (match?.[1]) {
      return {
        namespace: pattern.namespace,
        key: pattern.key,
        value: match[1].trim(),
      };
    }
  }

  if (EXPLICIT_USER_MEMORY_RE.test(lowered) && SELF_REFERENCE_RE.test(lowered)) {
    const statement = normalizeWhitespace(
      normalized
        .replace(
          /\b(ingat|remember|catat|simpan(?:kan)?\s+bahwa|remember\s+this\s+about\s+me)\b/gi,
          " ",
        )
        .replace(/\b(tentang\s+saya|about\s+me)\b/gi, " "),
    );
    if (statement) {
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
  }

  return undefined;
}

function deriveFactFromSourceText(params: {
  query: string;
  sourceText?: string;
}): UserFactDraft | undefined {
  const query = normalizeWhitespace(params.query).toLowerCase();
  const sourceText = params.sourceText?.trim();
  if (!sourceText) {
    return undefined;
  }

  const invoiceMatch = sourceText.match(
    /\binvoice(?:\s+number|\s+no\.?|\s*#)?\s*[:#-]?\s*([a-z0-9][a-z0-9-]{2,})\b/i,
  );
  if (invoiceMatch?.[1] && /\binvoice|faktur\b/i.test(query)) {
    return {
      namespace: "reference",
      key: "invoice.number",
      value: invoiceMatch[1].trim(),
    };
  }

  const ticketMatch = sourceText.match(
    /\b(?:ticket|tiket)(?:\s+number|\s+no\.?|\s*#)?\s*[:#-]?\s*([a-z0-9][a-z0-9-]{2,})\b/i,
  );
  if (ticketMatch?.[1] && /\bticket|tiket\b/i.test(query)) {
    return {
      namespace: "reference",
      key: "ticket.number",
      value: ticketMatch[1].trim(),
    };
  }

  const codeMatch = sourceText.match(
    /\b(?:code|kode)(?:\s+number|\s+no\.?|\s*#)?\s*[:#-]?\s*([a-z0-9][a-z0-9-]{2,})\b/i,
  );
  if (codeMatch?.[1] && /\bcode|kode\b/i.test(query)) {
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
  if (!AMBIGUOUS_SAVE_RE.test(normalized)) {
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

  if (EXPLICIT_DOC_SAVE_RE.test(query)) {
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

  if (
    (EXPLICIT_USER_MEMORY_RE.test(query) || USER_MEMORY_UPDATE_RE.test(query)) &&
    SELF_REFERENCE_RE.test(query)
  ) {
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
