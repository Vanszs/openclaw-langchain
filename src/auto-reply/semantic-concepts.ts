import { findCueTokenIndex, tokenizeCueText, type CueToken } from "./cue-matcher.js";

export type SemanticLexicon = Record<string, readonly string[]>;

export type SemanticToken = CueToken & {
  concepts: string[];
};

const DERIVED_SUFFIXES = ["nya", "lah", "kah", "pun"] as const;

type SemanticAliasIndex = {
  tokenIndex: Map<string, string[]>;
  phraseIndex: Array<{
    concept: string;
    parts: string[];
  }>;
};

function buildAliasIndex(lexicon: SemanticLexicon): SemanticAliasIndex {
  const tokenIndex = new Map<string, string[]>();
  const phraseIndex: SemanticAliasIndex["phraseIndex"] = [];
  for (const [concept, aliases] of Object.entries(lexicon)) {
    for (const alias of aliases) {
      const parts = tokenizeCueText(alias.trim().toLowerCase()).map((token) => token.value);
      if (parts.length === 0) {
        continue;
      }
      if (parts.length === 1) {
        const normalized = parts[0];
        const existing = tokenIndex.get(normalized) ?? [];
        if (!existing.includes(concept)) {
          existing.push(concept);
        }
        tokenIndex.set(normalized, existing);
        continue;
      }
      phraseIndex.push({ concept, parts });
    }
  }
  phraseIndex.sort((left, right) => right.parts.length - left.parts.length);
  return {
    tokenIndex,
    phraseIndex,
  };
}

function buildTokenVariants(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const variants = new Set([normalized]);
  for (const suffix of DERIVED_SUFFIXES) {
    if (normalized.length <= suffix.length + 1 || !normalized.endsWith(suffix)) {
      continue;
    }
    variants.add(normalized.slice(0, -suffix.length));
  }
  return [...variants];
}

export function tokenizeSemanticText(value: string, lexicon: SemanticLexicon): SemanticToken[] {
  const aliasIndex = buildAliasIndex(lexicon);
  const tokens = tokenizeCueText(value).map((token) => {
    const concepts = new Set<string>();
    for (const variant of buildTokenVariants(token.value)) {
      for (const concept of aliasIndex.tokenIndex.get(variant) ?? []) {
        concepts.add(concept);
      }
    }
    return {
      ...token,
      concepts: [...concepts],
    };
  });
  for (const phraseEntry of aliasIndex.phraseIndex) {
    const { concept, parts } = phraseEntry;
    for (let index = 0; index <= tokens.length - parts.length; index += 1) {
      const matches = parts.every((part, offset) =>
        buildTokenVariants(tokens[index + offset]?.value ?? "").includes(part),
      );
      if (!matches) {
        continue;
      }
      for (let offset = 0; offset < parts.length; offset += 1) {
        const token = tokens[index + offset];
        if (!token || token.concepts.includes(concept)) {
          continue;
        }
        token.concepts.push(concept);
      }
    }
  }
  return tokens;
}

export function hasSemanticConcept(tokens: SemanticToken[], concept: string): boolean {
  return tokens.some((token) => token.concepts.includes(concept));
}

export function findSemanticConceptIndex(
  tokens: SemanticToken[],
  concept: string,
  options?: { fromEnd?: boolean; startIndex?: number },
): number {
  const indexedTokens = tokens.map((token) => ({
    ...token,
    value: token.concepts.includes(concept) ? concept : token.value,
  }));
  return findCueTokenIndex(indexedTokens, new Set([concept]), options);
}

export function collectSemanticConceptIndexes(tokens: SemanticToken[], concept: string): number[] {
  return tokens.flatMap((token, index) => (token.concepts.includes(concept) ? [index] : []));
}

export function countSemanticConcepts(tokens: SemanticToken[], concept: string): number {
  return collectSemanticConceptIndexes(tokens, concept).length;
}

export function sliceSemanticTextFromTokenIndex(
  text: string,
  tokens: SemanticToken[],
  tokenIndex: number,
): string | undefined {
  if (tokenIndex < 0 || tokenIndex >= tokens.length) {
    return undefined;
  }
  return text.slice(tokens[tokenIndex].start).trim();
}
