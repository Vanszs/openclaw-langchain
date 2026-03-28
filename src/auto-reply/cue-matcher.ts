const WORD_TOKEN_RE = /[\p{L}\p{N}]+/gu;

export type CueToken = {
  value: string;
  start: number;
  end: number;
};

export type CueSpan = {
  startIndex: number;
  endIndex: number;
};

export function tokenizeCueText(value: string): CueToken[] {
  return Array.from(value.matchAll(WORD_TOKEN_RE), (match) => ({
    value: (match[0] ?? "").toLowerCase(),
    start: match.index ?? 0,
    end: (match.index ?? 0) + (match[0]?.length ?? 0),
  })).filter((token) => token.value.length > 0);
}

export function hasCueToken(tokens: CueToken[], cues: Set<string>): boolean {
  return tokens.some((token) => cues.has(token.value));
}

export function findCueTokenIndex(
  tokens: CueToken[],
  cues: Set<string>,
  options?: { fromEnd?: boolean; startIndex?: number },
): number {
  const fromEnd = options?.fromEnd === true;
  const startIndex = Math.max(0, options?.startIndex ?? 0);
  if (fromEnd) {
    for (let index = tokens.length - 1; index >= startIndex; index -= 1) {
      if (cues.has(tokens[index]?.value ?? "")) {
        return index;
      }
    }
    return -1;
  }
  for (let index = startIndex; index < tokens.length; index += 1) {
    if (cues.has(tokens[index]?.value ?? "")) {
      return index;
    }
  }
  return -1;
}

export function findPhraseSpan(
  tokens: CueToken[],
  phrase: readonly string[],
  options?: { fromEnd?: boolean; startIndex?: number },
): CueSpan | undefined {
  if (phrase.length === 0) {
    return undefined;
  }
  const fromEnd = options?.fromEnd === true;
  const startIndex = Math.max(0, options?.startIndex ?? 0);
  if (fromEnd) {
    for (let index = tokens.length - phrase.length; index >= startIndex; index -= 1) {
      const matches = phrase.every((part, offset) => tokens[index + offset]?.value === part);
      if (matches) {
        return {
          startIndex: index,
          endIndex: index + phrase.length,
        };
      }
    }
    return undefined;
  }
  for (let index = startIndex; index <= tokens.length - phrase.length; index += 1) {
    const matches = phrase.every((part, offset) => tokens[index + offset]?.value === part);
    if (matches) {
      return {
        startIndex: index,
        endIndex: index + phrase.length,
      };
    }
  }
  return undefined;
}

export function hasCuePhrase(tokens: CueToken[], phrase: readonly string[]): boolean {
  return Boolean(findPhraseSpan(tokens, phrase));
}

export function hasAnyCue(
  tokens: CueToken[],
  cueTokens: Set<string>,
  cuePhrases: ReadonlyArray<readonly string[]> = [],
): boolean {
  if (hasCueToken(tokens, cueTokens)) {
    return true;
  }
  return cuePhrases.some((phrase) => hasCuePhrase(tokens, phrase));
}

export function findAnyCueSpan(
  tokens: CueToken[],
  cueTokens: Set<string>,
  cuePhrases: ReadonlyArray<readonly string[]> = [],
  options?: { fromEnd?: boolean; startIndex?: number },
): CueSpan | undefined {
  const tokenIndex = findCueTokenIndex(tokens, cueTokens, options);
  const tokenSpan =
    tokenIndex >= 0
      ? {
          startIndex: tokenIndex,
          endIndex: tokenIndex + 1,
        }
      : undefined;
  const phraseSpan = cuePhrases
    .map((phrase) => findPhraseSpan(tokens, phrase, options))
    .filter((span): span is CueSpan => Boolean(span))
    .toSorted((left, right) =>
      options?.fromEnd ? right.startIndex - left.startIndex : left.startIndex - right.startIndex,
    )[0];
  if (!tokenSpan) {
    return phraseSpan;
  }
  if (!phraseSpan) {
    return tokenSpan;
  }
  return options?.fromEnd
    ? phraseSpan.startIndex > tokenSpan.startIndex
      ? phraseSpan
      : tokenSpan
    : phraseSpan.startIndex < tokenSpan.startIndex
      ? phraseSpan
      : tokenSpan;
}

export function sliceTextFromTokenIndex(
  text: string,
  tokens: CueToken[],
  tokenIndex: number,
): string | undefined {
  if (tokenIndex < 0 || tokenIndex >= tokens.length) {
    return undefined;
  }
  return text.slice(tokens[tokenIndex].start).trim();
}
