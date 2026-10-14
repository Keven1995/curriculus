import assert from "node:assert/strict";
import test from "node:test";
import {
  extractResumeTextFromPdf,
  ResumePdfError,
  RESUME_PDF_LIMITS,
  type PdfTextDocument,
  type ResumePdfFile,
} from "./resume-pdf";

const validPdfHeader = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function file(overrides: Partial<ResumePdfFile> = {}): ResumePdfFile {
  return {
    name: "curriculo.pdf",
    type: "application/pdf",
    size: validPdfHeader.byteLength,
    async arrayBuffer() {
      return validPdfHeader.buffer.slice(0);
    },
    ...overrides,
  };
}

function documentFromPages(pages: string[][]): PdfTextDocument {
  return {
    numPages: pages.length,
    async getPage(pageNumber) {
      return {
        async getTextContent() {
          return { items: pages[pageNumber - 1]!.map((str) => ({ str })) };
        },
      };
    },
  };
}

test("extracts selectable text from each PDF page and normalizes spacing", async () => {
  const text = await extractResumeTextFromPdf(file(), async () =>
    documentFromPages([["Desenvolvi", "APIs REST"], ["Experiência com Java"]]),
  );

  assert.equal(text, "Desenvolvi APIs REST\nExperiência com Java");
});

test("accepts an empty browser MIME type when the file extension and PDF signature are valid", async () => {
  const text = await extractResumeTextFromPdf(file({ type: "" }), async () =>
    documentFromPages([["Currículo de teste"]]),
  );
  assert.equal(text, "Currículo de teste");
});

test("rejects non-PDF and malformed input before invoking the parser", async () => {
  let parserCalls = 0;
  const reader = async () => {
    parserCalls += 1;
    return documentFromPages([["não deve ler"]]);
  };

  await assert.rejects(
    extractResumeTextFromPdf(file({ name: "curriculo.docx", type: "application/pdf" }), reader),
    (error: unknown) => error instanceof ResumePdfError && error.code === "unsupported_file",
  );
  await assert.rejects(
    extractResumeTextFromPdf(file({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }), reader),
    (error: unknown) => error instanceof ResumePdfError && error.code === "invalid_pdf",
  );
  assert.equal(parserCalls, 0);
});

test("rejects oversized files before reading their contents", async () => {
  let readCalls = 0;
  await assert.rejects(
    extractResumeTextFromPdf(file({
      size: RESUME_PDF_LIMITS.maximumFileBytes + 1,
      async arrayBuffer() {
        readCalls += 1;
        return validPdfHeader.buffer.slice(0);
      },
    }), async () => documentFromPages([["unused"]])),
    (error: unknown) => error instanceof ResumePdfError && error.code === "file_too_large",
  );
  assert.equal(readCalls, 0);
});

test("rejects scans without text, excessive page counts, and extracted text above the API limit", async () => {
  await assert.rejects(
    extractResumeTextFromPdf(file(), async () => documentFromPages([["   "]])),
    (error: unknown) => error instanceof ResumePdfError && error.code === "no_selectable_text",
  );
  await assert.rejects(
    extractResumeTextFromPdf(file(), async () => documentFromPages(Array.from(
      { length: RESUME_PDF_LIMITS.maximumPages + 1 },
      () => ["page"],
    ))),
    (error: unknown) => error instanceof ResumePdfError && error.code === "too_many_pages",
  );
  await assert.rejects(
    extractResumeTextFromPdf(file(), async () => documentFromPages([["x".repeat(RESUME_PDF_LIMITS.maximumCharacters + 1)]])),
    (error: unknown) => error instanceof ResumePdfError && error.code === "text_too_long",
  );
});

test("maps parser failures to a safe user-facing PDF error", async () => {
  await assert.rejects(
    extractResumeTextFromPdf(file(), async () => { throw new Error("parser details with document content"); }),
    (error: unknown) => error instanceof ResumePdfError && error.code === "invalid_pdf",
  );
});
