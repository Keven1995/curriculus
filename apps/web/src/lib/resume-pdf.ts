export const RESUME_PDF_LIMITS = {
  maximumFileBytes: 10 * 1024 * 1024,
  maximumPages: 30,
  maximumCharacters: 80_000,
} as const;

export type ResumePdfErrorCode =
  | "unsupported_file"
  | "file_too_large"
  | "invalid_pdf"
  | "too_many_pages"
  | "no_selectable_text"
  | "text_too_long";

const errorMessages: Record<ResumePdfErrorCode, string> = {
  unsupported_file: "Selecione um arquivo PDF.",
  file_too_large: "O PDF deve ter no máximo 10 MiB.",
  invalid_pdf: "Não foi possível ler este PDF. Confira se o arquivo está íntegro e tente novamente.",
  too_many_pages: "O PDF deve ter no máximo 30 páginas.",
  no_selectable_text: "Não encontramos texto selecionável. PDFs digitalizados como imagem não são compatíveis.",
  text_too_long: "O texto extraído excede 80.000 caracteres. Reduza o currículo e tente novamente.",
};

export class ResumePdfError extends Error {
  constructor(readonly code: ResumePdfErrorCode) {
    super(errorMessages[code]);
    this.name = "ResumePdfError";
  }
}

export type ResumePdfFile = Pick<File, "name" | "type" | "size" | "arrayBuffer">;

export type PdfTextDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: readonly unknown[] }>;
  }>;
  destroy?(): Promise<void>;
};

export type PdfTextReader = (data: Uint8Array) => Promise<PdfTextDocument>;

async function readPdfWithPdfJs(data: Uint8Array): Promise<PdfTextDocument> {
  const pdfjs = await import("pdfjs-dist/webpack.mjs");
  const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false });
  return loadingTask.promise;
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;
}

function textFromItem(item: unknown): string {
  if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") {
    return "";
  }
  return `${item.str}${"hasEOL" in item && item.hasEOL === true ? "\n" : " "}`;
}

function normalizeExtractedText(pages: readonly string[]): string {
  return pages
    .join("\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractResumeTextFromPdf(
  file: ResumePdfFile,
  reader: PdfTextReader = readPdfWithPdfJs,
): Promise<string> {
  const mimeType = file.type.toLowerCase();
  if (
    !file.name.toLowerCase().endsWith(".pdf") ||
    (mimeType !== "" && mimeType !== "application/pdf" && mimeType !== "application/x-pdf")
  ) {
    throw new ResumePdfError("unsupported_file");
  }
  if (file.size > RESUME_PDF_LIMITS.maximumFileBytes) throw new ResumePdfError("file_too_large");

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new ResumePdfError("invalid_pdf");
  }
  if (
    bytes.length === 0 ||
    bytes.length > RESUME_PDF_LIMITS.maximumFileBytes ||
    !hasPdfSignature(bytes)
  ) {
    throw new ResumePdfError("invalid_pdf");
  }

  let document: PdfTextDocument | undefined;
  try {
    document = await reader(bytes);
    if (!Number.isInteger(document.numPages) || document.numPages < 1) {
      throw new ResumePdfError("invalid_pdf");
    }
    if (document.numPages > RESUME_PDF_LIMITS.maximumPages) {
      throw new ResumePdfError("too_many_pages");
    }

    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(textFromItem).join(""));
    }

    const text = normalizeExtractedText(pages);
    if (!text) throw new ResumePdfError("no_selectable_text");
    if (Array.from(text).length > RESUME_PDF_LIMITS.maximumCharacters) {
      throw new ResumePdfError("text_too_long");
    }
    return text;
  } catch (error) {
    if (error instanceof ResumePdfError) throw error;
    throw new ResumePdfError("invalid_pdf");
  } finally {
    try {
      await document?.destroy?.();
    } catch {
      // Release errors must not replace the safe extraction result or error.
    }
  }
}
