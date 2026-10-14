import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  RESUME_LAYOUT_LIMITS,
  type RawResumeExtraction,
  type ResumeLayoutColor,
  type ResumeLayoutFontFamily,
  type ResumeLayoutFontWeight,
  type ResumeLayoutSection,
  type ResumeLayoutTemplateV3,
  type ResumeLayoutTextBlock,
  type ResumeLayoutVisualRegion,
} from "./resume-layout-types.js";
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
type FillRectangle = ExtractedPage["drawings"]["fill_rectangles"][number];
type TextPaint = { text: string; x: number; y: number; fontName: string; color: ResumeLayoutColor };
type PdfFontMetadata = { name?: string; fallbackName?: string };
type ColumnProfile = {
  splitPt: number;
  left: { x: number; right: number; blocks: ResumeLayoutTextBlock[] };
  right: { x: number; right: number; blocks: ResumeLayoutTextBlock[] };
};

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

function arrayLike(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<unknown>);
  }
  return undefined;
}

function colorFromComponents(value: unknown): ResumeLayoutColor | undefined {
  if (typeof value === "string") {
    const hex = /^#?([0-9a-f]{6})$/i.exec(value)?.[1];
    if (hex) return `#${hex.toUpperCase()}`;
    const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
    if (rgb) {
      const channels = rgb.slice(1).map(Number);
      if (channels.every((channel) => channel <= 255)) {
        return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase() as ResumeLayoutColor;
      }
    }
  }
  const parts = arrayLike(value);
  if (!parts || parts.length < 3) return undefined;
  const byteComponents = ArrayBuffer.isView(value) && !(value instanceof DataView);
  const channels = parts.slice(0, 3).map((part) => {
    const number = typeof part === "number" ? part : Number(part);
    if (!Number.isFinite(number)) return undefined;
    return Math.max(0, Math.min(255, Math.round(!byteComponents && number <= 1 ? number * 255 : number)));
  });
  if (channels.some((channel) => channel === undefined)) return undefined;
  return `#${channels.map((channel) => channel!.toString(16).padStart(2, "0")).join("")}`.toUpperCase() as ResumeLayoutColor;
}

function grayColor(value: unknown): ResumeLayoutColor | undefined {
  const gray = arrayLike(value)?.[0];
  if (typeof gray !== "number" || !Number.isFinite(gray)) return undefined;
  const channel = Math.max(0, Math.min(255, Math.round(gray <= 1 ? gray * 255 : gray)));
  return `#${channel.toString(16).padStart(2, "0").repeat(3)}`.toUpperCase() as ResumeLayoutColor;
}

function cmykColor(value: unknown): ResumeLayoutColor | undefined {
  const parts = arrayLike(value);
  if (!parts || parts.length < 4) return undefined;
  const [c, m, y, k] = parts.slice(0, 4).map((part) => Math.max(0, Math.min(1, numberOrZero(part))));
  if (c === undefined || m === undefined || y === undefined || k === undefined) return undefined;
  return `#${[
    Math.round(255 * (1 - c!) * (1 - k!)),
    Math.round(255 * (1 - m!) * (1 - k!)),
    Math.round(255 * (1 - y!) * (1 - k!)),
  ].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase() as ResumeLayoutColor;
}

function operatorCodes(ops: Record<string, number>, names: string[]): Set<number> {
  return new Set(names.map((name) => ops[name]).filter((value): value is number => typeof value === "number"));
}

function textFromOperatorArgument(value: unknown): string {
  const outer = arrayLike(value);
  const glyphs = arrayLike(outer?.[0]);
  if (!glyphs) return "";
  return glyphs.map((glyph) => {
    if (typeof glyph === "object" && glyph !== null && "unicode" in glyph && typeof glyph.unicode === "string") {
      return glyph.unicode;
    }
    return "";
  }).join("");
}

async function pageVisualEvidence(page: {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  commonObjs?: { get(id: string): unknown };
}, ops: Record<string, number>, pageWidth: number, pageHeight: number): Promise<{
  rectangleCount: number;
  unsupportedPathCount: number;
  fillColors: ResumeLayoutColor[];
  fillRectangles: FillRectangle[];
  imageCount: number;
  textPaints: TextPaint[];
  fonts: Record<string, PdfFontMetadata>;
}> {
  try {
    const operatorList = await page.getOperatorList();
    const imageOps = operatorCodes(ops, [
      "paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject",
      "paintSolidColorImageMask", "paintImageXObjectRepeat", "paintInlineImageXObjectGroup",
    ]);
    const fillOps = operatorCodes(ops, ["fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"]);
    const textOps = operatorCodes(ops, ["showText", "showSpacedText", "nextLineShowText", "nextLineSetSpacingShowText"]);
    const colors = new Set<ResumeLayoutColor>();
    const fillRectangles: FillRectangle[] = [];
    const textPaints: TextPaint[] = [];
    const fonts: Record<string, PdfFontMetadata> = {};
    let rectangleCount = 0;
    let unsupportedPathCount = 0;
    let imageCount = 0;
    let fillColor: ResumeLayoutColor = "#000000";
    let fontName = "unknown";
    let textX = 0;
    let textY = 0;
    let pendingRectangle: [number, number, number, number] | undefined;

    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      const operator = operatorList.fnArray[index]!;
      const args = operatorList.argsArray[index];
      if (imageOps.has(operator)) imageCount += 1;
      if (operator === ops.setFillRGBColor) fillColor = colorFromComponents(args) ?? fillColor;
      if (operator === ops.setFillGray) fillColor = grayColor(args) ?? fillColor;
      if (operator === ops.setFillCMYKColor) fillColor = cmykColor(args) ?? fillColor;
      if (operator === ops.setFillColor) fillColor = colorFromComponents(args) ?? fillColor;
      if (operator === ops.setFont) {
        const fontArgs = arrayLike(args);
        if (typeof fontArgs?.[0] === "string") {
          fontName = fontArgs[0];
          try {
            const font = page.commonObjs?.get(fontName);
            if (typeof font === "object" && font !== null) {
              const metadata = font as { name?: unknown; fallbackName?: unknown };
              fonts[fontName] = {
                ...(typeof metadata.name === "string" ? { name: metadata.name } : {}),
                ...(typeof metadata.fallbackName === "string" ? { fallbackName: metadata.fallbackName } : {}),
              };
            }
          } catch { /* Some PDFs reference unavailable or nonstandard font objects. */ }
        }
      }
      if (operator === ops.setTextMatrix) {
        const matrix = arrayLike(args);
        if (matrix && matrix.length >= 6) {
          textX = numberOrZero(matrix[4]);
          textY = numberOrZero(matrix[5]);
        }
      }
      if (operator === ops.moveText || operator === ops.setLeadingMoveText) {
        const move = arrayLike(args);
        if (move?.length && typeof move[0] === "number") textX += move[0];
        if (move?.length && typeof move[1] === "number") textY += move[1];
      }
      if (textOps.has(operator)) {
        const text = textFromOperatorArgument(args);
        if (text.trim()) textPaints.push({ text, x: textX, y: textY, fontName, color: fillColor });
      }
      if (operator === ops.constructPath) {
        const path = arrayLike(args);
        const pathOps = arrayLike(path?.[0])?.map(Number) ?? [];
        const bounds = arrayLike(path?.[2]);
        const rectOp = ops.rectangle;
        const rectCount = typeof rectOp === "number" ? pathOps.filter((pathOp) => pathOp === rectOp).length : 0;
        rectangleCount += rectCount;
        pendingRectangle = undefined;
        if (pathOps.length === 1 && rectCount === 1 && bounds && bounds.length >= 4) {
          const x1 = Math.max(0, Math.min(pageWidth, numberOrZero(bounds[0])));
          const y1 = Math.max(0, Math.min(pageHeight, numberOrZero(bounds[1])));
          const x2 = Math.max(0, Math.min(pageWidth, numberOrZero(bounds[2])));
          const y2 = Math.max(0, Math.min(pageHeight, numberOrZero(bounds[3])));
          if (x2 - x1 >= 1 && y2 - y1 >= 1) pendingRectangle = [x1, y1, x2, y2];
        } else if (pathOps.length > 0) {
          unsupportedPathCount += 1;
        }
        continue;
      }
      if (pendingRectangle && fillOps.has(operator)) {
        fillRectangles.push({ bbox: pendingRectangle, fill_color: fillColor });
        colors.add(fillColor);
        pendingRectangle = undefined;
      } else if (operator === ops.endPath || operator === ops.stroke || operator === ops.closeStroke) {
        pendingRectangle = undefined;
      }
    }

    return {
      rectangleCount,
      unsupportedPathCount,
      fillColors: [...colors].slice(0, 32),
      fillRectangles: fillRectangles.slice(0, RESUME_LAYOUT_LIMITS.maximumVectorRegions),
      imageCount,
      textPaints,
      fonts,
    };
  } catch {
    return { rectangleCount: 0, unsupportedPathCount: 0, fillColors: [], fillRectangles: [], imageCount: 0, textPaints: [], fonts: {} };
  }
}

function normalizedFontFamily(fontFamily: string, fontName: string): ResumeLayoutFontFamily {
  const name = `${fontFamily} ${fontName}`.toLowerCase();
  if (/mono|courier|consolas|typewriter/.test(name)) return "Courier";
  if (/(?:^|[^a-z])serif|times|georgia|garamond|cambria|baskerville/.test(name) && !/sans/.test(name)) return "Times-Roman";
  return "Helvetica";
}

function textPaintFor(item: PdfTextItem, paints: TextPaint[]): ResumeLayoutColor | undefined {
  const text = item.str.replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  const x = numberOrZero(item.transform?.[4]);
  const y = numberOrZero(item.transform?.[5]);
  let best: { distance: number; paint: TextPaint } | undefined;
  for (const paint of paints) {
    const candidateText = paint.text.replace(/\s+/gu, " ").trim();
    if (!candidateText || (!candidateText.includes(text) && !text.includes(candidateText))) continue;
    if (paint.fontName !== item.fontName) continue;
    const distance = Math.abs(paint.x - x) + Math.abs(paint.y - y);
    if (distance > 24) continue;
    if (!best || distance < best.distance) best = { distance, paint };
  }
  return best?.paint.color;
}

function lineBlocks(
  items: readonly unknown[],
  pageHeight: number,
  styles: Record<string, { fontFamily?: string }>,
  textPaints: TextPaint[],
  fonts: Record<string, PdfFontMetadata>,
): ResumeLayoutTextBlock[] {
  const spans: ResumeLayoutTextBlock["spans"] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") continue;
    const textItem = item as PdfTextItem;
    const text = textItem.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    if (!text) continue;
    const transform = Array.isArray(textItem.transform) ? textItem.transform : [];
    const x = numberOrZero(transform[4]);
    const baseline = pageHeight - numberOrZero(transform[5]);
    const transformedFontSize = Math.hypot(numberOrZero(transform[0]), numberOrZero(transform[1]));
    const fontSize = Math.max(1, Math.min(200, transformedFontSize || numberOrZero(textItem.height)));
    const height = Math.max(1, Math.min(200, numberOrZero(textItem.height) || fontSize));
    const width = Math.max(1, Math.min(10_000, numberOrZero(textItem.width)));
    const top = Math.max(0, baseline - height);
    const bottom = Math.min(pageHeight, baseline + 1);
    const fontId = typeof textItem.fontName === "string" ? textItem.fontName.slice(0, 160) : "unknown";
    const sourceFontName = fonts[fontId]?.name ?? fonts[fontId]?.fallbackName ?? fontId;
    const fontName = sourceFontName.slice(0, 160);
    const fontFamily = normalizedFontFamily(styles[fontId]?.fontFamily ?? "", fontName);
    const normalizedFont = `${fontName} ${fontFamily}`.toLowerCase();
    const fillColor = textPaintFor(textItem, textPaints);
    spans.push({
      text: text.slice(0, 2_000),
      bbox: [x, top, Math.min(20_000, x + width), bottom],
      fontName,
      fontFamily,
      fontSizePt: fontSize,
      weight: /bold|black|heavy|semibold|demi/.test(normalizedFont) ? "bold" : "normal",
      ...(fillColor ? { fillColor } : {}),
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
        const horizontalGap = span.bbox[0] >= candidate.bbox[2]
          ? span.bbox[0] - candidate.bbox[2]
          : candidate.bbox[0] - span.bbox[2];
        if (horizontalGap > Math.max(24, span.fontSizePt * 2.5)) break;
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

function columnProfile(blocks: ResumeLayoutTextBlock[], pageWidth: number, pageHeight: number): ColumnProfile | undefined {
  const candidates = blocks
    .filter((block) => block.bbox[2] - block.bbox[0] < pageWidth * 0.68)
    .map((block) => Math.round(block.bbox[0] / 5) * 5);
  const starts = [...new Set(candidates)].sort((a, b) => a - b);
  let best: { score: number; profile: ColumnProfile } | undefined;

  for (let index = 1; index < starts.length; index += 1) {
    const leftStart = starts[index - 1]!;
    const rightStart = starts[index]!;
    const gap = rightStart - leftStart;
    if (gap < pageWidth * 0.1) continue;
    const splitPt = rightStart - Math.max(20, Math.min(55, gap * 0.27));
    if (splitPt < pageWidth * 0.18 || splitPt > pageWidth * 0.82) continue;
    const leftBlocks = blocks.filter((block) => {
      const center = (block.bbox[0] + block.bbox[2]) / 2;
      return center < splitPt && block.bbox[2] - block.bbox[0] < pageWidth * 0.75;
    });
    const rightBlocks = blocks.filter((block) => {
      const center = (block.bbox[0] + block.bbox[2]) / 2;
      return center >= splitPt && block.bbox[2] - block.bbox[0] < pageWidth * 0.75;
    });
    if (leftBlocks.length < 2 || rightBlocks.length < 2) continue;
    const rowPairs = leftBlocks.filter((left) =>
      rightBlocks.some((right) => Math.abs(left.bbox[1] - right.bbox[1]) <= 40),
    ).length;
    if (rowPairs < 2) continue;

    const left = {
      x: Math.min(...leftBlocks.map((block) => block.bbox[0])),
      right: Math.max(...leftBlocks.map((block) => block.bbox[2])),
      blocks: leftBlocks,
    };
    const right = {
      x: Math.min(...rightBlocks.map((block) => block.bbox[0])),
      right: Math.max(...rightBlocks.map((block) => block.bbox[2])),
      blocks: rightBlocks,
    };
    if (left.right >= right.x || left.x > pageWidth * 0.38 || right.x < pageWidth * 0.35) continue;
    const verticalCoverage = Math.min(pageHeight, Math.max(
      ...leftBlocks.map((block) => block.bbox[3]),
      ...rightBlocks.map((block) => block.bbox[3]),
    )) - Math.max(0, Math.min(
      ...leftBlocks.map((block) => block.bbox[1]),
      ...rightBlocks.map((block) => block.bbox[1]),
    ));
    if (verticalCoverage < pageHeight * 0.018) continue;
    const score = gap * rowPairs * Math.min(leftBlocks.length, rightBlocks.length) / (leftBlocks.length + rightBlocks.length);
    if (!best || score > best.score) best = { score, profile: { splitPt, left, right } };
  }

  return best?.profile;
}

function colorLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16)) ?? [255, 255, 255];
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function sectionId(value: string): ResumeLayoutSection | undefined {
  const normalized = value.trim().replace(/[:\s]+$/, "").toLocaleLowerCase("pt-BR");
  if (/^(?:contato|contact|informa[cç][oõ]es de contato)$/.test(normalized)) return "contact";
  if (/^(?:forma[cç][aã]o|educa[cç][aã]o|forma[cç][aã]o acad[eê]mica|education)$/.test(normalized)) return "education";
  if (/^(?:habilidades|compet[eê]ncias|skills|conhecimentos|ferramentas|tecnologias|technical skills|tools)$/.test(normalized)) return "skills";
  if (/^(?:idiomas|l[ií]nguas|languages)$/.test(normalized)) return "languages";
  if (/^(?:resumo|perfil|sobre mim|objetivo|summary|profile)$/.test(normalized)) return "summary";
  if (/^(?:experi[eê]ncia|experi[eê]ncia profissional|hist[oó]rico profissional|experience|work experience)$/.test(normalized)) return "experience";
  if (/^(?:certifica[cç][oõ]es|cursos|cursos e certifica[cç][oõ]es|certifications)$/.test(normalized)) return "certifications";
  if (/^(?:projetos|publica[cç][oõ]es|voluntariado|pr[eê]mios)$/.test(normalized)) return "projects";
  const letters = value.replace(/[^\p{L}]/gu, "");
  if (value.trim().length > 2 && value.trim().length <= 72 && letters.length > 2 && letters === letters.toLocaleUpperCase("pt-BR")) return "other";
  return undefined;
}

function isKnownSectionHeading(value: string): boolean {
  const id = sectionId(value);
  return id !== undefined && id !== "other";
}

function detectSectionHeadings(
  pages: ExtractedPage[],
  excludedBlocks: Map<number, Set<ResumeLayoutTextBlock>>,
): Array<{ label: string; pageNumber: number; confidence: number }> {
  const labels: Partial<Record<ResumeLayoutSection, string>> = {
    contact: "Contato", education: "Formação", skills: "Competências", languages: "Idiomas",
    summary: "Resumo", experience: "Experiência", certifications: "Certificações", projects: "Projetos",
  };
  const found = new Map<ResumeLayoutSection, { label: string; pageNumber: number; confidence: number }>();
  for (const page of pages) {
    for (const block of page.text_blocks) {
      if (excludedBlocks.get(page.page_number)?.has(block)) continue;
      const id = sectionId(block.text);
      if (id && id !== "other" && !found.has(id)) {
        found.set(id, { label: labels[id] ?? block.text.trim(), pageNumber: page.page_number, confidence: 0.78 });
      }
    }
  }
  return [...found.values()];
}

function median(values: number[], fallback: number): number {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!finite.length) return fallback;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle]! : (finite[middle - 1]! + finite[middle]!) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function fontFromBlocks(blocks: ResumeLayoutTextBlock[], fallback: ResumeLayoutFontFamily): ResumeLayoutFontFamily {
  const counts = new Map<ResumeLayoutFontFamily, number>();
  for (const span of blocks.flatMap((block) => block.spans)) counts.set(span.fontFamily, (counts.get(span.fontFamily) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallback;
}

function weightFromBlocks(blocks: ResumeLayoutTextBlock[], fallback: ResumeLayoutFontWeight): ResumeLayoutFontWeight {
  const boldCount = blocks.flatMap((block) => block.spans).filter((span) => span.weight === "bold").length;
  const normalCount = blocks.flatMap((block) => block.spans).filter((span) => span.weight === "normal").length;
  return boldCount > normalCount ? "bold" : fallback;
}

type SpatialRegion = "header" | "sidebar" | "main";

function overlapRatio(block: ResumeLayoutTextBlock, x: number, y: number, width: number, height: number): number {
  const [left, top, right, bottom] = block.bbox;
  const intersection = Math.max(0, Math.min(right, x + width) - Math.max(left, x)) *
    Math.max(0, Math.min(bottom, y + height) - Math.max(top, y));
  const area = Math.max(1, right - left) * Math.max(1, bottom - top);
  return intersection / area;
}

/** Assigns a block using its measured bounds, colored regions, and column geometry. */
function spatialRegion(
  block: ResumeLayoutTextBlock,
  page: ExtractedPage,
  columns: ResumeLayoutTemplateV3["columns"],
  regions: ResumeLayoutVisualRegion[],
): SpatialRegion {
  const colored = regions
    .filter((region) => (region.role === "sidebar"
      ? region.pageNumber === page.page_number || region.repeatOnPages
      : region.pageNumber === page.page_number) && (region.role === "sidebar" || region.role === "header"))
    .map((region) => ({ region, overlap: overlapRatio(block, region.x, region.y, region.width, region.height) }))
    .filter((entry) => entry.overlap >= 0.28)
    .sort((left, right) => right.overlap - left.overlap)[0];
  if (colored) return colored.region.role === "sidebar" ? "sidebar" : "header";

  if (columns.count === 2) {
    const sidebarOverlap = overlapRatio(block, columns.sidebarXPt, 0, columns.sidebarWidthPt, page.height_pt);
    const mainOverlap = overlapRatio(block, columns.mainXPt, 0, columns.mainWidthPt, page.height_pt);
    if (sidebarOverlap >= 0.5 && sidebarOverlap > mainOverlap) return "sidebar";
    if (mainOverlap >= 0.5 && mainOverlap > sidebarOverlap) return "main";
    const center = (block.bbox[0] + block.bbox[2]) / 2;
    if (center >= columns.sidebarXPt && center <= columns.sidebarXPt + columns.sidebarWidthPt) return "sidebar";
    if (center >= columns.mainXPt && center <= columns.mainXPt + columns.mainWidthPt) return "main";
    return columns.sidebarSide === "left"
      ? (center < columns.mainXPt ? "sidebar" : "main")
      : (center >= columns.sidebarXPt ? "sidebar" : "main");
  }

  const header = regions.find((region) => region.role === "header" && region.pageNumber === 1);
  return header && overlapRatio(block, header.x, header.y, header.width, header.height) >= 0.35 ? "header" : "main";
}

function sectionPlacements(
  pages: ExtractedPage[],
  columns: ResumeLayoutTemplateV3["columns"],
  regions: ResumeLayoutVisualRegion[],
): ResumeLayoutTemplateV3["visual"]["sectionPlacements"] {
  const placements: ResumeLayoutTemplateV3["visual"]["sectionPlacements"] = [];
  const seen = new Set<ResumeLayoutSection>();
  for (const page of pages) {
    for (const block of page.text_blocks) {
      const section = sectionId(block.text);
      if (!section || seen.has(section)) continue;
      seen.add(section);
      const headingSpan = representativeSpan(block);
      placements.push({
        section,
        region: spatialRegion(block, page, columns, regions) === "sidebar" ? "sidebar" : "main",
        pageNumber: page.page_number,
        yPt: block.bbox[1] + (headingSpan?.fontSizePt ?? 10.5) * 0.32,
      });
    }
  }
  return placements;
}

function normalizedComparableText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}@.+-]+/gu, " ")
    .replace(/\s+/gu, " ").trim().toLocaleLowerCase("pt-BR");
}

function representativeSpan(block: ResumeLayoutTextBlock): ResumeLayoutTextBlock["spans"][number] | undefined {
  return block.spans.slice().sort((left, right) => right.fontSizePt - left.fontSizePt)[0];
}

function similarPosition(left: ResumeLayoutTextBlock, right: ResumeLayoutTextBlock, page: ExtractedPage): boolean {
  const toleranceX = Math.max(18, page.width_pt * 0.045);
  const toleranceY = Math.max(8, page.height_pt * 0.018);
  return Math.abs(left.bbox[0] - right.bbox[0]) <= toleranceX && Math.abs(left.bbox[1] - right.bbox[1]) <= toleranceY;
}

function similarStyle(left: ResumeLayoutTextBlock, right: ResumeLayoutTextBlock): boolean {
  const a = representativeSpan(left);
  const b = representativeSpan(right);
  if (!a || !b) return false;
  return a.fontFamily === b.fontFamily && a.weight === b.weight && Math.abs(a.fontSizePt - b.fontSizePt) <= 2.5 &&
    (!a.fillColor || !b.fillColor || a.fillColor === b.fillColor);
}

function topOrBottomFurnitureBand(block: ResumeLayoutTextBlock, page: ExtractedPage): boolean {
  return block.bbox[1] <= page.height_pt * 0.16 || block.bbox[3] >= page.height_pt * 0.84;
}

function isContinuationLabel(value: string): boolean {
  return /^(?:continua(?:cao|tion)|continued|continuation|pagina\s+\d+(?:\s+de\s+\d+)?)$/u.test(normalizedComparableText(value));
}

function isPaginationLabel(value: string): boolean {
  return /^(?:(?:p(?:agina)?|page)\s*)?\d+(?:\s*(?:de|\/|of)\s*\d+)?$/u.test(normalizedComparableText(value));
}

type FurnitureDetection = {
  excludedBlocks: Map<number, Set<ResumeLayoutTextBlock>>;
  exclusions: Array<{
    page_number: number;
    text: string;
    reason: "repeated_name" | "continuation_label" | "pagination";
  }>;
  warnings: string[];
};

/**
 * Removes only strong presentation signals. Exact repeated names must match in
 * geometry and typography; continuation labels also need a matching title slot.
 * Other top/bottom lookalikes are kept and surfaced as uncertainty.
 */
function detectRecurringFurniture(pages: ExtractedPage[], firstPageText: string): FurnitureDetection {
  const excludedBlocks = new Map<number, Set<ResumeLayoutTextBlock>>();
  const warnings: string[] = [];
  const firstPage = pages[0];
  const exclusions: FurnitureDetection["exclusions"] = [];
  if (!firstPage || pages.length < 2) return { excludedBlocks, exclusions, warnings };

  const firstLine = firstPageText.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const nameBlock = nameBlockForPage(firstPage, firstLine || firstPageText);
  const firstPageTitleSlots = firstPage.text_blocks.filter((block) =>
    block !== nameBlock && block.bbox[1] <= firstPage.height_pt * 0.16 && block.text.trim().length <= 80 &&
    !isKnownSectionHeading(block.text) && block.text.replace(/[^\p{L}]/gu, "").length > 2,
  );
  const exclude = (pageNumber: number, block: ResumeLayoutTextBlock, reason: FurnitureDetection["exclusions"][number]["reason"]) => {
    const existing = excludedBlocks.get(pageNumber) ?? new Set<ResumeLayoutTextBlock>();
    if (existing.has(block)) return;
    existing.add(block);
    excludedBlocks.set(pageNumber, existing);
    exclusions.push({ page_number: pageNumber, text: block.text, reason });
  };

  for (const anchor of firstPage.text_blocks.filter((block) => isPaginationLabel(block.text) && topOrBottomFurnitureBand(block, firstPage))) {
    const matched = pages.map((page) => page.text_blocks.find((block) => isPaginationLabel(block.text) &&
      topOrBottomFurnitureBand(block, page) && similarPosition(anchor, block, page) && similarStyle(anchor, block)));
    if (matched.every((block): block is ResumeLayoutTextBlock => Boolean(block))) {
      matched.forEach((block, index) => exclude(pages[index]!.page_number, block, "pagination"));
    }
  }

  for (const page of pages.slice(1)) {
    const pageCandidates = page.text_blocks.filter((block) => topOrBottomFurnitureBand(block, page));
    for (const block of pageCandidates) {
      const normalized = normalizedComparableText(block.text);
      const repeatedName = Boolean(nameBlock && normalized && normalized === normalizedComparableText(nameBlock.text) &&
        topOrBottomFurnitureBand(nameBlock, firstPage) && similarPosition(nameBlock, block, page) && similarStyle(nameBlock, block));
      if (repeatedName) {
        exclude(page.page_number, block, "repeated_name");
        continue;
      }

      if (isContinuationLabel(block.text)) {
        const matchingTitleSlot = firstPageTitleSlots.some((candidate) =>
          similarPosition(candidate, block, page) && similarStyle(candidate, block),
        );
        if (matchingTitleSlot) exclude(page.page_number, block, "continuation_label");
        else warnings.push("Um possível rótulo de continuação não coincidiu com segurança com um cabeçalho visual; o texto foi preservado.");
        continue;
      }

      if (excludedBlocks.get(page.page_number)?.has(block)) continue;

      const alignedLookalike = firstPage.text_blocks.some((candidate) =>
        topOrBottomFurnitureBand(candidate, firstPage) && similarPosition(candidate, block, page) && similarStyle(candidate, block),
      );
      if (alignedLookalike && (normalized || block.text.trim().length > 0)) {
        warnings.push("Texto no cabeçalho/rodapé parece elemento de apresentação, mas não foi possível distingui-lo de conteúdo legítimo; foi preservado.");
      }
    }
  }
  return { excludedBlocks, exclusions, warnings: [...new Set(warnings)] };
}

function itemBelongsToFurniture(item: PdfTextItem, pageHeight: number, block: ResumeLayoutTextBlock): boolean {
  const text = normalizedComparableText(item.str);
  const blockText = normalizedComparableText(block.text);
  if (!text || !blockText || (!blockText.includes(text) && !text.includes(blockText))) return false;
  const x = numberOrZero(item.transform?.[4]);
  const top = pageHeight - numberOrZero(item.transform?.[5]) - Math.max(1, numberOrZero(item.height));
  const width = Math.max(1, numberOrZero(item.width));
  const height = Math.max(1, numberOrZero(item.height));
  return overlapRatio({ text: item.str, bbox: [x, top, x + width, top + height], spans: [] },
    block.bbox[0], block.bbox[1], block.bbox[2] - block.bbox[0], block.bbox[3] - block.bbox[1]) >= 0.45;
}

function isContactInformation(value: string): boolean {
  return /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d ()-]{7,}\d)|(?:https?:\/\/|www\.)\S+|linkedin\.com|github\.com|,\s*[A-Z]{2}\b)/iu.test(value);
}

function contactRegionFor(
  pages: ExtractedPage[],
  columns: ResumeLayoutTemplateV3["columns"],
  regions: ResumeLayoutVisualRegion[],
): "header" | "sidebar" | "main" | undefined {
  const page = pages[0];
  if (!page) return undefined;
  const contactHeading = page.text_blocks.find((block) => sectionId(block.text) === "contact");
  const candidates = contactHeading
    ? page.text_blocks.filter((block) => block.bbox[1] >= contactHeading.bbox[1] && block.bbox[1] <= contactHeading.bbox[1] + 130 &&
      block !== contactHeading && isContactInformation(block.text))
    : page.text_blocks.filter((block) => isContactInformation(block.text));
  const chosen = candidates[0] ?? contactHeading;
  return chosen ? spatialRegion(chosen, page, columns, regions) : undefined;
}

function isSidebarRect(rectangle: FillRectangle, page: ExtractedPage): boolean {
  const [x1, y1, x2, y2] = rectangle.bbox;
  const width = x2 - x1;
  const height = y2 - y1;
  return width >= page.width_pt * 0.12 && width <= page.width_pt * 0.48 && height >= page.height_pt * 0.72 &&
    (x1 <= page.width_pt * 0.08 || x2 >= page.width_pt * 0.92) && y1 <= page.height_pt * 0.08;
}

function isHeaderRect(rectangle: FillRectangle, page: ExtractedPage): boolean {
  const [x1, y1, x2, y2] = rectangle.bbox;
  const width = x2 - x1;
  const height = y2 - y1;
  return y1 <= page.height_pt * 0.1 && width >= page.width_pt * 0.38 && height >= page.height_pt * 0.06 &&
    height <= page.height_pt * 0.42 && !(width >= page.width_pt * 0.8 && height >= page.height_pt * 0.72);
}

function roleForRegion(rectangle: FillRectangle, page: ExtractedPage): ResumeLayoutVisualRegion["role"] {
  if (isSidebarRect(rectangle, page)) return "sidebar";
  if (isHeaderRect(rectangle, page)) return "header";
  return "accent";
}

function inferredVisualRegions(pages: ExtractedPage[]): ResumeLayoutVisualRegion[] {
  const firstPage = pages[0]!;
  const firstRectangles = firstPage.drawings.fill_rectangles;
  return firstRectangles.slice(0, RESUME_LAYOUT_LIMITS.maximumVectorRegions).map((rectangle) => {
    const role = roleForRegion(rectangle, firstPage);
    const [x1, y1, x2, y2] = rectangle.bbox;
    const occurrences = pages.filter((page) => page.drawings.fill_rectangles.some((candidate) => {
      const candidateRole = roleForRegion(candidate, page);
      return candidateRole === role && candidate.fill_color === rectangle.fill_color &&
        Math.abs(candidate.bbox[0] - x1) <= 3 && Math.abs(candidate.bbox[1] - y1) <= 3 &&
        Math.abs(candidate.bbox[2] - x2) <= 3 && Math.abs(candidate.bbox[3] - y2) <= 3;
    })).length;
    const repeatOnPages = role === "sidebar" && (pages.length === 1 || occurrences >= Math.ceil(pages.length * 0.6));
    return {
      role,
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      color: rectangle.fill_color as ResumeLayoutColor,
      pageNumber: 1,
      repeatOnPages,
    };
  });
}

function nameBlockForPage(page: ExtractedPage, firstText: string): ResumeLayoutTextBlock | undefined {
  const candidates = page.text_blocks.filter((block) =>
    block.bbox[1] <= page.height_pt * 0.3 && !isKnownSectionHeading(block.text) && block.text.trim().length <= 120,
  );
  const firstLine = firstText.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const normalizedFirstLine = normalizedComparableText(firstLine);
  const matchingBlock = candidates.find((block) => normalizedFirstLine && !isContactInformation(block.text) &&
    normalizedComparableText(block.text).includes(normalizedFirstLine));
  if (matchingBlock) return matchingBlock;

  const sidebar = page.drawings.fill_rectangles.find((rectangle) => isSidebarRect(rectangle, page));
  if (sidebar) {
    const [x1, y1, x2, y2] = sidebar.bbox;
    const spatialCandidates = candidates.filter((block) => block.bbox[1] <= page.height_pt * 0.16 &&
      overlapRatio(block, x1, y1, x2 - x1, y2 - y1) >= 0.5);
    if (spatialCandidates.length) {
      return spatialCandidates.sort((left, right) => {
        const leftSpan = representativeSpan(left);
        const rightSpan = representativeSpan(right);
        return left.bbox[1] - right.bbox[1] || (rightSpan?.fontSizePt ?? 0) - (leftSpan?.fontSizePt ?? 0);
      })[0];
    }
  }
  return candidates.sort((left, right) => {
    const leftSpan = representativeSpan(left);
    const rightSpan = representativeSpan(right);
    return left.bbox[1] - right.bbox[1] || (rightSpan?.fontSizePt ?? 0) - (leftSpan?.fontSizePt ?? 0);
  })[0];
}

function inferTemplate(
  pages: ExtractedPage[],
  imageCount: number,
  resumeText: string,
  extractionWarnings: string[],
): ResumeLayoutTemplateV3 {
  const firstPage = pages[0]!;
  const detectedColumns = columnProfile(firstPage.text_blocks, firstPage.width_pt, firstPage.height_pt);
  const regions = inferredVisualRegions(pages);
  const sidebarRegion = regions.find((region) => region.role === "sidebar");
  const headerRegion = regions.find((region) => region.role === "header");
  const firstPageBlocks = firstPage.text_blocks;
  const pageLeft = Math.max(0, Math.min(...firstPageBlocks.map((block) => block.bbox[0])));
  const pageTop = Math.max(0, Math.min(...firstPageBlocks.map((block) => block.bbox[1])));
  const pageRight = Math.min(firstPage.width_pt, Math.max(...firstPageBlocks.map((block) => block.bbox[2])));
  const pageBottom = Math.min(firstPage.height_pt, Math.max(...firstPageBlocks.map((block) => block.bbox[3])));
  const marginPt = clamp(Math.min(pageLeft, firstPage.width_pt - pageRight), 12, 90);
  const contentBounds = {
    x: pageLeft,
    y: pageTop,
    width: Math.max(1, pageRight - pageLeft),
    height: Math.max(1, pageBottom - pageTop),
  };

  let sidebarSide: "left" | "right" = "left";
  let sidebarXPt = 0;
  let sidebarWidthPt = 0;
  let gapPt = 0;
  let mainXPt = marginPt;
  let mainWidthPt = Math.max(80, firstPage.width_pt - mainXPt - marginPt);
  let sidebarRepeats = false;
  const hasTwoColumns = Boolean(detectedColumns || sidebarRegion);

  if (hasTwoColumns) {
    if (sidebarRegion) {
      sidebarXPt = sidebarRegion.x;
      sidebarWidthPt = sidebarRegion.width;
      sidebarSide = sidebarXPt + sidebarWidthPt / 2 < firstPage.width_pt / 2 ? "left" : "right";
      sidebarRepeats = sidebarRegion.repeatOnPages;
    } else if (detectedColumns) {
      const leftWidth = detectedColumns.left.right - detectedColumns.left.x;
      const rightWidth = detectedColumns.right.right - detectedColumns.right.x;
      sidebarSide = leftWidth <= rightWidth ? "left" : "right";
      const side = sidebarSide === "left" ? detectedColumns.left : detectedColumns.right;
      sidebarXPt = Math.max(0, side.x - Math.min(16, marginPt * 0.55));
      sidebarWidthPt = Math.max(80, Math.min(firstPage.width_pt * 0.48, side.right - sidebarXPt + Math.min(14, marginPt * 0.45)));
      gapPt = Math.max(10, Math.min(42, detectedColumns.right.x - detectedColumns.left.right));
      sidebarRepeats = pages.length === 1 || pages.slice(1).every((page) => columnProfile(page.text_blocks, page.width_pt, page.height_pt));
    }
    if (sidebarSide === "left") {
      mainXPt = sidebarXPt + sidebarWidthPt + Math.max(8, gapPt || 16);
      mainWidthPt = Math.max(80, firstPage.width_pt - mainXPt - marginPt);
    } else {
      mainXPt = marginPt;
      mainWidthPt = Math.max(80, sidebarXPt - Math.max(8, gapPt || 16) - mainXPt);
    }
    if (sidebarRegion && detectedColumns) {
      gapPt = Math.max(8, sidebarSide === "left"
        ? detectedColumns.right.x - (sidebarXPt + sidebarWidthPt)
        : sidebarXPt - detectedColumns.left.right);
      gapPt = clamp(gapPt, 8, 50);
      if (sidebarSide === "left") mainXPt = sidebarXPt + sidebarWidthPt + gapPt;
      else mainWidthPt = Math.max(80, sidebarXPt - gapPt - mainXPt);
    }
  }

  const spanSizes = firstPageBlocks.flatMap((block) => block.spans.map((span) => span.fontSizePt));
  const bodyPt = clamp(median(spanSizes.filter((size) => size <= 18), 10.5), 7.5, 16);
  const firstLogicalLine = resumeText.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const firstBlock = nameBlockForPage(firstPage, firstLogicalLine) ?? firstPageBlocks[0]!;
  const nameSpan = firstBlock.spans.slice().sort((left, right) => right.fontSizePt - left.fontSizePt)[0];
  const namePt = clamp(nameSpan?.fontSizePt ?? Math.max(bodyPt + 3, 20), 12, 42);
  const headingSizes = firstPageBlocks.filter((block) => sectionId(block.text)).flatMap((block) => block.spans.map((span) => span.fontSizePt));
  const sectionPt = clamp(median(headingSizes, bodyPt + 2), bodyPt, 24);
  const lineGaps: number[] = [];
  const orderedByY = firstPageBlocks.slice().sort((left, right) => left.bbox[1] - right.bbox[1]);
  const splitPoint = detectedColumns?.splitPt ?? (sidebarRegion
    ? (sidebarRegion.x + sidebarRegion.width / 2 < firstPage.width_pt / 2
      ? sidebarRegion.x + sidebarRegion.width
      : sidebarRegion.x)
    : firstPage.width_pt / 2);
  for (let index = 1; index < orderedByY.length; index += 1) {
    const previous = orderedByY[index - 1]!;
    const current = orderedByY[index]!;
    const sameColumn = !hasTwoColumns ||
      (((previous.bbox[0] + previous.bbox[2]) / 2 < splitPoint) === ((current.bbox[0] + current.bbox[2]) / 2 < splitPoint));
    const gap = current.bbox[1] - previous.bbox[3];
    if (sameColumn && gap > 0 && gap < bodyPt * 3) lineGaps.push(gap);
  }
  const bodyLineHeightRatio = clamp(1 + median(lineGaps, bodyPt * 0.35) / bodyPt, 1.12, 1.8);
  const textColors = firstPageBlocks.flatMap((block) => block.spans.map((span) => span.fillColor).filter((color): color is ResumeLayoutColor => Boolean(color)));
  const darkTextColor = textColors.filter((color) => colorLuminance(color) < 155);
  const bodyTextColor = (darkTextColor.sort((left, right) => textColors.filter((color) => color === right).length - textColors.filter((color) => color === left).length)[0] ?? "#202725") as ResumeLayoutColor;
  const accentTextColor = darkTextColor.find((color) => color !== bodyTextColor) ?? bodyTextColor;
  const regionColors = regions.map((region) => region.color);
  const sidebarColor = sidebarRegion?.color ?? "#FFFFFF";
  const headerColor = headerRegion?.color ?? (regionColors.find((color) => colorLuminance(color) >= 85 && colorLuminance(color) < 245) ?? "#FFFFFF");
  const warnings = ["A preservação visual é aproximada; confira o PDF final antes de usá-lo.", ...extractionWarnings];
  if (imageCount > 0) warnings.push("Imagens e fotos do PDF original não são copiadas para o documento gerado.");
  if (pages.some((page) => page.drawings.unsupported_path_count > 0)) warnings.push("Alguns elementos vetoriais complexos foram simplificados ou omitidos.");
  if (pages.some((page) => Math.abs(page.width_pt - firstPage.width_pt) > 2 || Math.abs(page.height_pt - firstPage.height_pt) > 2)) {
    warnings.push("O PDF mistura tamanhos de página; o documento gerado usará o tamanho da primeira página.");
  }
  warnings.push("A fonte original pode ser substituída por uma fonte padrão visualmente semelhante.");
  if (pages.some((page) => page.drawings.rectangle_count > page.drawings.fill_rectangles.length)) {
    warnings.push("Nem todos os elementos gráficos simples puderam ser reaplicados.");
  }

  const detectedColumnCount: 1 | 2 = hasTwoColumns ? 2 : 1;
  const geometryConfidence = firstPageBlocks.length >= 4 ? 0.78 : firstPageBlocks.length >= 2 ? 0.62 : 0.4;
  const confidence = clamp(geometryConfidence + (regions.length ? 0.08 : 0) + (detectedColumns ? 0.06 : 0), 0.35, 0.94);
  const firstNameText = firstBlock.text.trim();
  const nameSpatialRegion = spatialRegion(firstBlock, firstPage, {
    count: detectedColumnCount,
    sidebarWidthPt,
    gapPt,
    sidebarRepeats,
    sidebarSide,
    sidebarXPt,
    mainXPt,
    mainWidthPt,
  }, regions);
  const nameRegion: "sidebar" | "main" = nameSpatialRegion === "sidebar" ? "sidebar" : "main";
  const contactRegion = contactRegionFor(pages, {
    count: detectedColumnCount,
    sidebarWidthPt,
    gapPt,
    sidebarRepeats,
    sidebarSide,
    sidebarXPt,
    mainXPt,
    mainWidthPt,
  }, regions);
  const nameBounds = nameSpatialRegion === "sidebar"
    ? { x: sidebarXPt, width: sidebarWidthPt }
    : nameSpatialRegion === "header" && headerRegion
      ? { x: headerRegion.x, width: headerRegion.width }
      : { x: mainXPt, width: mainWidthPt };
  const leftInset = firstBlock.bbox[0] - nameBounds.x;
  const rightInset = nameBounds.x + nameBounds.width - firstBlock.bbox[2];
  const nameAlignment = Math.abs(leftInset - rightInset) < nameBounds.width * 0.04
    ? "center"
    : rightInset < leftInset ? "right" : "left";
  const formatIsA4 = Math.abs(firstPage.width_pt - 595.28) < 8 && Math.abs(firstPage.height_pt - 841.89) < 8;
  const template: ResumeLayoutTemplateV3 = {
    schemaVersion: "3.0",
    id: "adaptive-resume-layout-v1",
    page: {
      format: formatIsA4 ? "A4" : "custom",
      widthPt: firstPage.width_pt,
      heightPt: firstPage.height_pt,
      marginPt,
    },
    palette: { sidebar: sidebarColor, main: "#FFFFFF", headerApprox: headerColor, text: bodyTextColor },
    columns: {
      count: detectedColumnCount,
      sidebarWidthPt,
      gapPt,
      sidebarRepeats,
      sidebarSide,
      sidebarXPt,
      mainXPt,
      mainWidthPt,
    },
    header: {
      heightPt: headerRegion?.height ?? 0,
      nameUppercase: firstNameText === firstNameText.toLocaleUpperCase("pt-BR"),
      nameAlignment,
      nameTextColor: nameSpan?.fillColor ?? bodyTextColor,
      nameRegion,
      nameXPt: firstBlock.bbox[0],
      nameYPt: (nameSpan?.bbox[1] ?? firstBlock.bbox[1]) + (nameSpan?.fontSizePt ?? namePt) * 0.32,
      ...(contactRegion ? { contactRegion } : {}),
    },
    typography: {
      namePt,
      sectionPt,
      bodyPt,
      nameFont: nameSpan?.fontFamily ?? fontFromBlocks(firstPageBlocks, "Helvetica"),
      headingFont: fontFromBlocks(firstPageBlocks.filter((block) => sectionId(block.text)), "Helvetica"),
      bodyFont: fontFromBlocks(firstPageBlocks.filter((block) => !sectionId(block.text)), "Helvetica"),
      nameWeight: nameSpan?.weight ?? "bold",
      headingWeight: weightFromBlocks(firstPageBlocks.filter((block) => sectionId(block.text)), "bold"),
      bodyWeight: weightFromBlocks(firstPageBlocks.filter((block) => !sectionId(block.text)), "normal"),
    },
    sections: ["summary", "experience", "education", "certifications"],
    sidebarSections: ["contact", "education", "skills", "languages"],
    overflow: { wrapText: true, pageBreak: true, keepExperienceHeadingWithFirstBullet: true },
    detection: { confidence, detectedColumns: detectedColumnCount, warnings },
    visual: {
      contentBounds,
      regions,
      sectionPlacements: [],
      bodyTextColor,
      headingTextColor: accentTextColor,
      bodyLineHeightRatio,
      paragraphGapPt: clamp(bodyPt * 0.38, 2, 10),
      warnings,
    },
  };
  template.visual.sectionPlacements = sectionPlacements(pages, template.columns, regions);
  return template;
}

export type ExtractedResumeLayout = {
  rawExtraction: RawResumeExtraction;
  template: ResumeLayoutTemplateV3;
  resumeText: string;
  layoutAvailable: boolean;
  layoutWarnings: string[];
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

function textFromItems(
  items: readonly unknown[],
  pageHeight?: number,
  excludedBlocks: Set<ResumeLayoutTextBlock> = new Set(),
): string {
  return items.map((item) => {
    if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") return "";
    if (pageHeight !== undefined && excludedBlocks.size > 0 && "transform" in item) {
      const textItem = item as PdfTextItem;
      if ([...excludedBlocks].some((block) => itemBelongsToFurniture(textItem, pageHeight, block))) return "";
    }
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
    const pageTextItems: PdfTextItem[][] = [];
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
      pageTextItems.push((textContent.items as readonly unknown[]).filter((item): item is PdfTextItem =>
        typeof item === "object" && item !== null && "str" in item && typeof item.str === "string" &&
        "transform" in item && Array.isArray(item.transform),
      ));
      const visual = await pageVisualEvidence(page, pdfjs.OPS as Record<string, number>, viewport.width, viewport.height);
      const textBlocks = lineBlocks(textContent.items as readonly unknown[], viewport.height, textContent.styles, visual.textPaints, visual.fonts);
      totalBlocks += textBlocks.length;
      totalCharacters += textBlocks.reduce((total, block) => total + Array.from(block.text).length, 0);
      if (totalBlocks > RESUME_LAYOUT_LIMITS.maximumTextBlocks) throw new ResumeLayoutError("text_too_long");
      if (totalCharacters > RESUME_LAYOUT_LIMITS.maximumCharacters) throw new ResumeLayoutError("text_too_long");
      imageCount += visual.imageCount;
      pages.push({
        page_number: pageNumber,
        width_pt: Number(viewport.width.toFixed(2)),
        height_pt: Number(viewport.height.toFixed(2)),
        text_blocks: textBlocks,
        drawings: {
          rectangle_count: visual.rectangleCount,
          unsupported_path_count: visual.unsupportedPathCount,
          fill_colors: visual.fillColors,
          fill_rectangles: visual.fillRectangles,
          extracted_as_paths: false,
        },
      });
    }
    const unfilteredFirstPageText = textFromItems(pageTextItems[0] ?? []);
    const furniture = detectRecurringFurniture(pages, unfilteredFirstPageText);
    const resumeText = normalizeResumeText(pageTextItems.map((items, index) =>
      textFromItems(items, pages[index]!.height_pt, furniture.excludedBlocks.get(index + 1)),
    ));
    if (!resumeText) throw new ResumeLayoutError("no_selectable_text");
    if (Array.from(resumeText).length > RESUME_LAYOUT_LIMITS.maximumCharacters) throw new ResumeLayoutError("text_too_long");

    const template = inferTemplate(pages, imageCount, resumeText, furniture.warnings);
    const firstPage = pages[0]!;
    const a4 = Math.abs(firstPage.width_pt - 595.28) < 8 && Math.abs(firstPage.height_pt - 841.89) < 8;
    const rawExtraction: RawResumeExtraction = {
      schema_version: "1.1",
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
        note: "O PDF é processado em memória. A extração guarda texto, coordenadas e evidências visuais; OCR, imagens e páginas de fundo não são reutilizados.",
      },
      ...(furniture.warnings.length > 0 ? { extraction_warnings: furniture.warnings } : {}),
      ...(furniture.exclusions.length > 0 ? { excluded_furniture: furniture.exclusions } : {}),
    };
    return {
      rawExtraction,
      template,
      resumeText,
      layoutAvailable: template.detection.confidence >= 0.4,
      layoutWarnings: template.visual.warnings,
      detectedSections: detectSectionHeadings(pages, furniture.excludedBlocks),
      fileHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ResumeLayoutError) throw error;
    if (signal?.aborted) throw new ResumeLayoutError("processing_timeout");
    if (
      typeof error === "object" && error !== null &&
      (("name" in error && error.name === "PasswordException") || ("code" in error && error.code === 1))
    ) throw new ResumeLayoutError("encrypted_pdf");
    throw new ResumeLayoutError("invalid_pdf");
  } finally {
    try { await document?.destroy(); } catch { /* Release errors must not replace the bounded extraction result. */ }
  }
}
