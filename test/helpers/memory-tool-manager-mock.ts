import { vi } from "vitest";
import type { MemoryDomain, MemorySource } from "../../src/memory/types.js";

export type SearchImpl = (
  query?: string,
  opts?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
    sources?: MemorySource[];
    domain?: MemoryDomain;
  },
) => Promise<unknown[]>;
export type MemoryReadParams = { relPath: string; from?: number; lines?: number };
export type MemoryReadResult = { text: string; path: string };
type MemoryBackend = "builtin" | "qmd";

let backend: MemoryBackend = "builtin";
let statusSources: MemorySource[] = ["memory"];
let searchImpl: SearchImpl = async () => [];
let readFileImpl: (params: MemoryReadParams) => Promise<MemoryReadResult> = async (params) => ({
  text: "",
  path: params.relPath,
});

const stubManager = {
  search: vi.fn(
    async (query?: string, opts?: Parameters<SearchImpl>[1]) => await searchImpl(query, opts),
  ),
  readFile: vi.fn(async (params: MemoryReadParams) => await readFileImpl(params)),
  status: () => ({
    backend,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir: "/workspace",
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: statusSources,
    sourceCounts: statusSources.map((source) => ({ source, files: 1, chunks: 1 })),
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

vi.mock("../../src/memory/index.js", () => ({
  getMemorySearchManager: async () => ({ manager: stubManager }),
}));

export function setMemoryBackend(next: MemoryBackend): void {
  backend = next;
}

export function setMemorySearchImpl(next: SearchImpl): void {
  searchImpl = next;
}

export function setMemoryReadFileImpl(
  next: (params: MemoryReadParams) => Promise<MemoryReadResult>,
): void {
  readFileImpl = next;
}

export function resetMemoryToolMockState(overrides?: {
  backend?: MemoryBackend;
  statusSources?: MemorySource[];
  searchImpl?: SearchImpl;
  readFileImpl?: (params: MemoryReadParams) => Promise<MemoryReadResult>;
}): void {
  backend = overrides?.backend ?? "builtin";
  statusSources = overrides?.statusSources ?? ["memory"];
  searchImpl = overrides?.searchImpl ?? (async () => []);
  readFileImpl =
    overrides?.readFileImpl ??
    (async (params: MemoryReadParams) => ({ text: "", path: params.relPath }));
  vi.clearAllMocks();
}

export function getMemorySearchMock() {
  return stubManager.search;
}

export function getMemoryReadFileMock() {
  return stubManager.readFile;
}
