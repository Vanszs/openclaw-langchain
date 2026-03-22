import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.fn();
const describeImagesWithModelMock = vi.fn();
const fromDocumentsMock = vi.fn();
const splitTextMock = vi.fn();
const { extractPdfContentMock, runWithImageModelFallbackMock } = vi.hoisted(() => ({
  extractPdfContentMock: vi.fn(),
  runWithImageModelFallbackMock: vi.fn(),
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("../agents/model-fallback.js", () => ({
  runWithImageModelFallback: runWithImageModelFallbackMock,
}));

vi.mock("../media-understanding/providers/image.js", () => ({
  describeImagesWithModel: describeImagesWithModelMock,
}));

vi.mock("../media/pdf-extract.js", () => ({
  extractPdfContent: extractPdfContentMock,
}));

vi.mock("@langchain/openai", () => ({
  OpenAIEmbeddings: class OpenAIEmbeddings {
    constructor(public readonly fields: Record<string, unknown>) {}
  },
}));

vi.mock("@langchain/classic/vectorstores/memory", () => ({
  MemoryVectorStore: {
    fromDocuments: fromDocumentsMock,
  },
}));

vi.mock("@langchain/textsplitters", () => ({
  RecursiveCharacterTextSplitter: class RecursiveCharacterTextSplitter {
    async splitText(text: string) {
      return splitTextMock(text);
    }
  },
}));

type AttachmentRagModule = typeof import("./attachment-rag.js");
let buildAttachmentRetrievalContextNote: AttachmentRagModule["buildAttachmentRetrievalContextNote"];

describe("buildAttachmentRetrievalContextNote", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "or-test" });
    runWithImageModelFallbackMock.mockImplementation(async ({ cfg, run, onError }) => {
      const primary = cfg?.agents?.defaults?.imageModel?.primary;
      const fallbacks = cfg?.agents?.defaults?.imageModel?.fallbacks ?? [];
      const refs = [
        primary ?? "openrouter/qwen/qwen-2.5-vl-7b-instruct",
        ...(fallbacks.length > 0 ? fallbacks : ["openrouter/anthropic/claude-sonnet-4-6"]),
      ].filter((value): value is string => typeof value === "string" && value.includes("/"));
      let lastError: unknown;
      const attempts: Array<{ provider: string; model: string; error: string }> = [];
      for (const [index, ref] of refs.entries()) {
        const slash = ref.indexOf("/");
        const provider = ref.slice(0, slash);
        const model = ref.slice(slash + 1);
        try {
          const result = await run(provider, model);
          return { result, provider, model, attempts };
        } catch (error) {
          lastError = error;
          attempts.push({
            provider,
            model,
            error: error instanceof Error ? error.message : String(error),
          });
          await onError?.({
            provider,
            model,
            error,
            attempt: index + 1,
            total: refs.length,
          });
        }
      }
      throw lastError ?? new Error("No image model configured");
    });
    extractPdfContentMock.mockResolvedValue({
      text: "native pdf text",
      images: [],
    });
    splitTextMock.mockImplementation(async (text: string) => [text]);
    fromDocumentsMock.mockImplementation(async (documents: Array<{ pageContent: string }>) => ({
      similaritySearchWithScore: async () => [
        [documents[0], 0.91],
        ...(documents[1] ? [[documents[1], 0.73]] : []),
      ],
    }));
    ({ buildAttachmentRetrievalContextNote } = await import("./attachment-rag.js"));
  });

  it("builds retrieved context for text attachments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, "alpha project timeline and budget");

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["text/plain"],
      },
      cfg: undefined,
      agentDir: "/tmp/agent",
      query: "what is the budget",
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter" }),
    );
    expect(note).toContain("Retrieved attachment context");
    expect(note).toContain("notes.txt");
    expect(note).toContain("alpha project timeline and budget");
  });

  it("falls back to OCR text for scanned PDFs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "scan.pdf");
    await fs.writeFile(filePath, "%PDF-1.4 fake");

    extractPdfContentMock.mockResolvedValue({
      text: "",
      images: [{ data: Buffer.from("img").toString("base64"), mimeType: "image/png" }],
    });

    describeImagesWithModelMock.mockResolvedValue({ text: "invoice total 42", model: "qwen" });

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["application/pdf"],
      },
      cfg: {
        agents: {
          defaults: {
            imageModel: { primary: "openrouter/qwen/qwen-2.5-vl-7b-instruct" },
          },
        },
      },
      agentDir: "/tmp/agent",
      query: "total",
    });

    expect(describeImagesWithModelMock).toHaveBeenCalledOnce();
    expect(note).toContain("scan.pdf");
    expect(note).toContain("pdf-ocr");
    expect(note).toContain("invoice total 42");
  });

  it("extracts OCR text from image attachments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "receipt.png");
    await fs.writeFile(filePath, "png-bytes");

    describeImagesWithModelMock.mockResolvedValue({ text: "receipt total 19.99", model: "qwen" });

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["image/png"],
      },
      cfg: undefined,
      agentDir: "/tmp/agent",
      query: "what is the total",
    });

    expect(describeImagesWithModelMock).toHaveBeenCalledOnce();
    expect(note).toContain("Binary attachments are never forwarded to text models");
    expect(note).toContain("receipt.png");
    expect(note).toContain("image-ocr");
    expect(note).toContain("receipt total 19.99");
    expect(describeImagesWithModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Act as an OCR engine."),
      }),
    );
  });

  it("salvages quoted OCR text from descriptive vision captions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "receipt.png");
    await fs.writeFile(filePath, "png-bytes");

    describeImagesWithModelMock.mockResolvedValue({
      text:
        'The image displays the text "CAT CODE ZX9Q7M TOTAL 481". ' +
        "Here are the key features: the text is centered and the background is white.",
      model: "qwen",
    });

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["image/png"],
      },
      cfg: undefined,
      agentDir: "/tmp/agent",
      query: "what does the image say",
    });

    expect(note).toContain("CAT CODE ZX9Q7M TOTAL 481");
    expect(note).not.toContain("Here are the key features");
  });

  it("falls back across OCR image models when the primary OCR candidate fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "scan.pdf");
    await fs.writeFile(filePath, "%PDF-1.4 fake");

    extractPdfContentMock.mockResolvedValue({
      text: "",
      images: [{ data: Buffer.from("img").toString("base64"), mimeType: "image/png" }],
    });
    describeImagesWithModelMock
      .mockRejectedValueOnce(new Error("primary down"))
      .mockResolvedValueOnce({ text: "fallback OCR text", model: "claude-sonnet" });

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["application/pdf"],
      },
      cfg: {
        agents: {
          defaults: {
            imageModel: {
              primary: "openrouter/qwen/qwen-2.5-vl-7b-instruct",
              fallbacks: ["openrouter/anthropic/claude-sonnet-4-6"],
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      query: "summarize",
    });

    expect(describeImagesWithModelMock).toHaveBeenCalledTimes(2);
    expect(note).toContain("fallback OCR text");
  });

  it("falls back when the primary OCR output looks low confidence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "receipt.png");
    await fs.writeFile(filePath, "png-bytes");

    describeImagesWithModelMock
      .mockResolvedValueOnce({
        text: "The visible text in the image is: CAT 9 7.",
        model: "qwen",
      })
      .mockResolvedValueOnce({
        text: "CAT CODE ZX9Q7M TOTAL 481",
        model: "llama",
      });

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["image/png"],
      },
      cfg: {
        agents: {
          defaults: {
            imageModel: {
              primary: "openrouter/qwen/qwen-2.5-vl-7b-instruct",
              fallbacks: ["openrouter/meta-llama/llama-3.2-11b-vision-instruct"],
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      query: "what does the image say",
    });

    expect(describeImagesWithModelMock).toHaveBeenCalledTimes(2);
    expect(note).toContain("CAT CODE ZX9Q7M TOTAL 481");
    expect(note).not.toContain("CAT 9 7");
  });

  it("keeps the strongest OCR candidate when every vision result is imperfect", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "receipt.png");
    await fs.writeFile(filePath, "png-bytes");

    describeImagesWithModelMock
      .mockResolvedValueOnce({
        text: "CAT CODE 481",
        model: "qwen",
      })
      .mockResolvedValueOnce({
        text: "CAT 7",
        model: "llama",
      });

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["image/png"],
      },
      cfg: {
        agents: {
          defaults: {
            imageModel: {
              primary: "openrouter/qwen/qwen-2.5-vl-7b-instruct",
              fallbacks: ["openrouter/meta-llama/llama-3.2-11b-vision-instruct"],
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      query: "what does the image say",
    });

    expect(describeImagesWithModelMock).toHaveBeenCalledTimes(2);
    expect(note).toContain("CAT CODE 481");
    expect(note).not.toContain("CAT 7");
  });

  it("returns a metadata-only note when OCR is unavailable for all relevant attachments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "receipt.png");
    await fs.writeFile(filePath, "png-bytes");

    describeImagesWithModelMock.mockRejectedValue(new Error("vision unavailable"));

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["image/png"],
      },
      cfg: undefined,
      agentDir: "/tmp/agent",
      query: "what does the receipt say",
    });

    expect(note).toContain("Retrieval mode: metadata-only");
    expect(note).toContain("Files processed: receipt.png");
    expect(note).toContain("OCR status: unavailable for receipt.png:");
    expect(note).toContain("No extracted text was available");
  });

  it("falls back to deterministic excerpts when vector retrieval fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, "alpha project timeline and budget");

    fromDocumentsMock.mockRejectedValueOnce(new Error("vector store offline"));

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["text/plain"],
      },
      cfg: undefined,
      agentDir: "/tmp/agent",
      query: "what is the budget",
    });

    expect(note).toContain("Retrieval mode: deterministic-excerpt");
    expect(note).toContain("Vector retrieval unavailable: vector store offline.");
    expect(note).toContain("alpha project timeline and budget");
  });

  it("falls back to deterministic excerpts when vector retrieval returns no matches", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-rag-"));
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, "alpha project timeline and budget");

    fromDocumentsMock.mockImplementationOnce(async () => ({
      similaritySearchWithScore: async () => [],
    }));

    const note = await buildAttachmentRetrievalContextNote({
      ctx: {
        MediaPaths: [filePath],
        MediaTypes: ["text/plain"],
      },
      cfg: undefined,
      agentDir: "/tmp/agent",
      query: "what is the budget",
    });

    expect(note).toContain("Retrieval mode: deterministic-excerpt");
    expect(note).toContain("Vector retrieval returned no matches; using deterministic excerpts.");
    expect(note).toContain("alpha project timeline and budget");
  });
});
