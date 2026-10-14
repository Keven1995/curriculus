import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RESUME_LAYOUT_LIMITS, type RawResumeExtraction, type ResumeLayoutColor, type ResumeLayoutTemplate, type ResumeLayoutTextBlock } from "./resume-layout-types.js";
import { ResumeLayoutError } from "./resume-layout-errors.js";

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
};

type ExtractedPage = RawResumeExtraction["pages"][number];

function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function safeFileName(value: string): string {
  const baseName = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (baseName || "referencia.pdf").slice(0, 180);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function colorFromComponents(value: unknown): string | undefined {
  if (typeof value === "string") {
    const hex = /^#?([0-9a-f]{6})$/i.exec(value)?.[1];
    if (hex) return `#${hex.toUpperCase()}`;
    const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
    if (rgb) {
      const channels = rgb.slice(1).map(Number);
      if (channels.every((channel) => channel <= 255)) {
        return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
      }
    }
  }
  const componentsInput = Array.isArray(value)
    ? value
    : ArrayBuffer.isView(value) && !(value instanceof DataView)
      ? Array.from(value as unknown as ArrayLike<unknown>)
      : undefined;
  if (!componentsInput || componentsInput.length < 3) return undefined;
  const components = componentsInput.slice(0, 3).map((part) => {
    const number = typeof part === "number" ? part : Number(part);
    if (!Number.isFinite(number)) return undefined;
    return Math.max(0, Math.min(255, Math.round(number <= 1 ? number * 255 : number)));
  });
  if (components.some((component) => component === undefined)) return undefined;
  return `#${components.map((component) => component!.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function imageOperatorCodes(ops: Record<string, number>): Set<number> {
  return new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
    ops.paintSolidColorImageMask,
  ].filter((value): value is number => typeof value === "number"));
}

async function pageVisualEvidence(page: {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
}, ops: Record<string, number>): Promise<ExtractedPage["drawings"] & { imageCount: number }> {
  try {
    const operatorList = await page.getOperatorList();
    const imageOps = imageOperatorCodes(ops);
    const colors = new Set<string>();
    let rectangleCount = 0;
    let imageCount = 0;
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      const operator = operatorList.fnArray[index];
      if (imageOps.has(operator!)) imageCount += 1;
      if (operator === ops.rectangle) rectangleCount += 1;
      if (operator === ops.setFillRGBColor) {
        const color = colorFromComponents(operatorList.argsArray[index]);
        if (color) colors.add(color);
      }
    }
    return {
      rectangle_count: rectangleCount,
      fill_colors: [...colors].slice(0, 32),
      extracted_as_paths: false,
      imageCount,
    };
  } catch {
    return { rectangle_count: 0, fill_colors: [], extracted_as_paths: false, imageCount: 0 };
  }
}

function lineBlocks(
  items: readonly unknown[],
  pageHeight: number,
  styles: Record<string, { fontFamily?: string }>,
): ResumeLayoutTextBlock[] {
  const spans: ResumeLayoutTextBlock["spans"] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") continue;
    const textItem = item as PdfTextItem;
    const text = textItem.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    if (!text) continue;
    const x = numberOrZero(textItem.transform?.[4]);
    const baseline = pageHeight - numberOrZero(textItem.transform?.[5]);
    const height = Math.max(1, Math.min(200, numberOrZero(textItem.height)));
    const width = Math.max(1, Math.min(10_000, numberOrZero(textItem.width)));
    const top = Math.max(0, baseline - height);
    const bottom = Math.min(pageHeight, baseline + 1);
    const fontName = typeof textItem.fontName === "string" ? textItem.fontName.slice(0, 160) : "unknown";
    const fontFamily = styles[fontName]?.fontFamily ?? "";
    const normalizedFont = `${fontName} ${fontFamily}`.toLowerCase();
    spans.push({
      text: text.slice(0, 2_000),
      bbox: [x, top, Math.min(20_000, x + width), bottom],
      fontName,
      fontSizePt: Math.max(1, Math.min(200, height)),
      weight: /bold|black|heavy|semibold|demi/.test(normalizedFont) ? "bold" : "normal",
    });
  }

  spans.sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
  const blocks: ResumeLayoutTextBlock[] = [];
  for (const span of spans) {
    const baseline = span.bbox[3];
    let block: ResumeLayoutTextBlock | undefined;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const candidate = blocks[index]!;
      if (Math.abs(candidate.bbox[3] - baseline) <= Math.max(2.5, span.fontSizePt * 0.25)) {
        if (span.bbox[0] - candidate.bbox[2] > Math.max(24, span.fontSizePt * 2.5)) break;
        block = candidate;
        break;
      }
      if (candidate.bbox[3] < baseline - span.fontSizePt * 2) break;
    }
    if (!block) {
      block = { text: "", bbox: [...span.bbox], spans: [] };
      blocks.push(block);
    }
    block.spans.push(span);
    block.bbox = [
      Math.min(block.bbox[0], span.bbox[0]),
      Math.min(block.bbox[1], span.bbox[1]),
      Math.max(block.bbox[2], span.bbox[2]),
      Math.max(block.bbox[3], span.bbox[3]),
    ];
  }

  for (const block of blocks) {
    block.spans.sort((left, right) => left.bbox[0] - right.bbox[0]);
    let text = "";
    let previousRight: number | undefined;
    for (const span of block.spans) {
      if (previousRight !== undefined && span.bbox[0] - previousRight > span.fontSizePt * 0.16) text += " ";
      text += span.text;
      previousRight = span.bbox[2];
    }
    block.text = text.slice(0, 4_000);
  }

  return blocks;
}

function bestTwoColumnSplit(blocks: ResumeLayoutTextBlock[], pageWidth: number): number | undefined {
  const starts = [...new Set(blocks.map((block) => Math.round(block.bbox[0] / 5) * 5))].sort((a, b) => a - b);
  let best: { gap: number; rightStart: number; leftStart: number } | undefined;
  for (let index = 1; index < starts.length; index += 1) {
    const leftStart = starts[index - 1]!;
    const rightStart = starts[index]!;
    const gap = rightStart - leftStart;
    const estimatedSplit = rightStart - 50;
    if (gap < pageWidth * 0.1 || estimatedSplit < pageWidth * 0.22 || estimatedSplit > pageWidth * 0.72) continue;
    const leftCount = blocks.filter((block) => block.bbox[0] < rightStart - gap * 0.5).length;
    const rightCount = blocks.filter((block) => block.bbox[0] >= rightStart - gap * 0.5).length;
    if (leftCount < 2 || rightCount < 2) continue;
    if (!best || gap > best.gap) best = { gap, rightStart, leftStart };
  }
  return best ? Math.max(135, Math.min(210, best.rightStart - 50)) : undefined;
}

function colorLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16)) ?? [255, 255, 255];
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function inferTemplate(pages: ExtractedPage[]): ResumeLayoutTemplate {
  const firstPage = pages[0]!;
  const sidebarWidth = bestTwoColumnSplit(firstPage.text_blocks, firstPage.width_pt);
  const colors = [...new Set(pages.flatMap((page) => page.drawings.fill_colors))];
  const darkColor = (colors.find((color) => colorLuminance(color) < 100) ?? "#404040") as ResumeLayoutColor;
  const accentColor = (colors.find((color) => {
    const luminance = colorLuminance(color);
    return luminance >= 100 && luminance < 235 && color !== darkColor;
  }) ?? "#A3C6C1") as ResumeLayoutColor;
  const detectedColumns: 1 | 2 = sidebarWidth ? 2 : 1;
  const warnings = [
    "A leitura de layout é aproximada; confira a prévia antes de baixar.",
    "Imagens do PDF de referência foram contabilizadas, mas não extraídas nem reutilizadas.",
    "Desenhos vetoriais são evidências técnicas e não são reproduzidos pixel a pixel.",
  ];
  if (!sidebarWidth) warnings.unshift("Não foi possível confirmar duas colunas; o renderer usará a largura de sidebar padrão suportada.");
  return {
    schemaVersion: "2.0",
    id: "sidebar-dark-header-color-v1",
    page: { format: "A4", widthPt: 595.28, heightPt: 841.89, marginPt: 30 },
    palette: { sidebar: darkColor, main: "#FFFFFF", headerApprox: accentColor, text: "#111111" },
    columns: { sidebarWidthPt: sidebarWidth ?? 170, gapPt: 20, sidebarRepeats: true },
    header: { heightPt: 140, nameUppercase: true },
    typography: { namePt: 26, sectionPt: 14, bodyPt: 10.5 },
    sections: ["summary", "experience", "education", "certifications"],
    sidebarSections: ["photo", "contact", "skills"],
    overflow: { wrapText: true, pageBreak: true, keepExperienceHeadingWithFirstBullet: true },
    detection: {
      confidence: sidebarWidth ? 0.48 : 0.22,
      detectedColumns,
      warnings,
    },
  };
}

function detectSectionHeadings(pages: ExtractedPage[]): Array<{ label: string; pageNumber: number; confidence: number }> {
  const knownSections: Array<[RegExp, string]> = [
    [/^(?:resumo|perfil|sobre mim|objetivo)\b/i, "Resumo"],
    [/^(?:experi[eê]ncia|hist[oó]rico profissional|atua[cç][oõ]es)\b/i, "Experiência"],
    [/^(?:forma[cç][aã]o|educa[cç][aã]o|acad[eê]mica)\b/i, "Formação"],
    [/^(?:habilidades|compet[eê]ncias|skills)\b/i, "Competências"],
    [/^(?:certifica[cç][oõ]es|cursos)\b/i, "Certificações"],
    [/^(?:contato|contact)\b/i, "Contato"],
  ];
  const found = new Map<string, { label: string; pageNumber: number; confidence: number }>();
  for (const page of pages) {
    for (const block of page.text_blocks) {
      const value = block.text.trim().replace(/[:\s]+$/, "");
      const heading = knownSections.find(([pattern]) => pattern.test(value));
      if (heading && !found.has(heading[1])) {
        found.set(heading[1], { label: heading[1], pageNumber: page.page_number, confidence: 0.68 });
      }
    }
  }
  return [...found.values()];
}

export type ExtractedResumeLayout = {
  rawExtraction: RawResumeExtraction;
  template: ResumeLayoutTemplate;
  resumeText: string;
  layoutAvailable: boolean;
  detectedSections: Array<{ label: string; pageNumber: number; confidence: number }>;
  fileHash: string;
};

function normalizeResumeText(pages: readonly string[]): string {
  return pages
    .join("\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textFromItems(items: readonly unknown[]): string {
  return items.map((item) => {
    if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") return "";
    const text = item.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    return `${text}${"hasEOL" in item && item.hasEOL === true ? "\n" : " "}`;
  }).join("");
}

export async function extractPdfLayout(bytes: Buffer, fileName: string, signal?: AbortSignal): Promise<ExtractedResumeLayout> {
  if (bytes.length > RESUME_LAYOUT_LIMITS.maximumPdfBytes) throw new ResumeLayoutError("file_too_large");
  if (bytes.length < 5 || !hasPdfSignature(bytes)) throw new ResumeLayoutError("invalid_pdf");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = fileURLToPath(new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));
  let document: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | undefined;
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
      standardFontDataUrl,
      stopAtErrors: true,
      maxImageSize: 20_000_000,
    });
    const destroyOnAbort = () => { void loadingTask.destroy(); };
    signal?.addEventListener("abort", destroyOnAbort, { once: true });
    document = await loadingTask.promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1) throw new ResumeLayoutError("invalid_pdf");
    if (document.numPages > RESUME_LAYOUT_LIMITS.maximumPages) throw new ResumeLayoutError("too_many_pages");

    const pages: ExtractedPage[] = [];
    const resumePages: string[] = [];
    let imageCount = 0;
    let totalCharacters = 0;
    let totalBlocks = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (signal?.aborted) throw new ResumeLayoutError("processing_timeout");
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      if (
        !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
        viewport.width < 100 || viewport.height < 100 || viewport.width > 5_000 || viewport.height > 5_000
      ) throw new ResumeLayoutError("invalid_pdf");
      const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      resumePages.push(textFromItems(textContent.items as readonly unknown[]));
      const textBlocks = lineBlocks(textContent.items as readonly unknown[], viewport.height, textContent.styles);
      totalBlocks += textBlocks.length;
      totalCharacters += textBlocks.reduce((total, block) => total + Array.from(block.text).length, 0);
      if (totalBlocks > RESUME_LAYOUT_LIMITS.maximumTextBlocks) throw new ResumeLayoutError("text_too_long");
      if (totalCharacters > RESUME_LAYOUT_LIMITS.maximumCharacters) throw new ResumeLayoutError("text_too_long");
      const visual = await pageVisualEvidence(page, pdfjs.OPS as Record<string, number>);
      imageCount += visual.imageCount;
      pages.push({
        page_number: pageNumber,
        width_pt: Number(viewport.width.toFixed(2)),
        height_pt: Number(viewport.height.toFixed(2)),
        text_blocks: textBlocks,
        drawings: {
          rectangle_count: visual.rectangle_count,
          fill_colors: visual.fill_colors,
          extracted_as_paths: false,
        },
      });
    }
    const resumeText = normalizeResumeText(resumePages);
    if (!resumeText) throw new ResumeLayoutError("no_selectable_text");
    if (Array.from(resumeText).length > RESUME_LAYOUT_LIMITS.maximumCharacters) {
      throw new ResumeLayoutError("text_too_long");
    }

    const template = inferTemplate(pages);
    const firstPage = pages[0]!;
    const a4 = Math.abs(firstPage.width_pt - 595.28) < 8 && Math.abs(firstPage.height_pt - 841.89) < 8;
    const rawExtraction: RawResumeExtraction = {
      schema_version: "1.0",
      source_file: { name: safeFileName(fileName), size_bytes: bytes.length },
      coordinate_system: "PDF points; origin at top-left",
      page: {
        format: a4 ? "A4" : "custom",
        width_pt: firstPage.width_pt,
        height_pt: firstPage.height_pt,
      },
      template: {
        supported_template_id: template.id,
        detected_columns: template.detection.detectedColumns,
        confidence: template.detection.confidence,
      },
      images: { count: imageCount, bytes_extracted: false, reused_in_output: false },
      pages,
      usage: {
        ocr: false,
        source_pdf_retained: false,
        note: "O PDF é processado em memória. Texto e coordenadas aparecem nesta extração; OCR e reutilização de imagens não estão habilitados.",
      },
    };
    return {
      rawExtraction,
      template,
      resumeText,
      layoutAvailable: template.detection.detectedColumns === 2 && template.detection.confidence >= 0.4,
      detectedSections: detectSectionHeadings(pages),
      fileHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ResumeLayoutError) throw error;
    if (signal?.aborted) throw new ResumeLayoutError("processing_timeout");
    if (
      typeof error === "object" && error !== null &&
      (("name" in error && error.name === "PasswordException") || ("code" in error && error.code === 1))
    ) {
      throw new ResumeLayoutError("encrypted_pdf");
    }
    throw new ResumeLayoutError("invalid_pdf");
  } finally {
    try {
      await document?.destroy();
    } catch {
      // Release errors must not replace the bounded extraction result.
    }
  }
}
