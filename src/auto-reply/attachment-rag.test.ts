import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.fn();
const describeImagesWithModelMock = vi.fn();
const fromDocumentsMock = vi.fn();
const splitTextMock = vi.fn();

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("../media-understanding/providers/image.js", () => ({
  describeImagesWithModel: describeImagesWithModelMock,
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

    vi.doMock("../media/pdf-extract.js", () => ({
      extractPdfContent: vi.fn(async () => ({
        text: "",
        images: [{ data: Buffer.from("img").toString("base64"), mimeType: "image/png" }],
      })),
    }));
    vi.resetModules();
    ({ buildAttachmentRetrievalContextNote } = await import("./attachment-rag.js"));

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
});
