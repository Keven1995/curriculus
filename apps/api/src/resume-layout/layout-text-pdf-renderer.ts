import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import {
  RESUME_LAYOUT_LIMITS,
  type ResumeLayoutFontFamily,
  type ResumeLayoutSection,
  type ResumeLayoutTemplate,
  type ResumeLayoutTemplateV2,
  type ResumeLayoutTemplateV3,
} from "./resume-layout-types.js";
import { ResumeLayoutError } from "./resume-layout-errors.js";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const PAGE_BOTTOM = 802;

function wrapPdfText(
  document: PDFKit.PDFDocument,
  value: string,
  maximumWidth: number,
  font: string,
  fontSize: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (document.font(font).fontSize(fontSize).widthOfString(candidate) <= maximumWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (document.font(font).fontSize(fontSize).widthOfString(word) <= maximumWidth) {
        line = word;
        continue;
      }
      let fragment = "";
      for (const character of word) {
        const extended = fragment + character;
        if (document.font(font).fontSize(fontSize).widthOfString(extended) > maximumWidth && fragment) {
          lines.push(fragment);
          fragment = character;
        } else fragment = extended;
      }
      line = fragment;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function headingKind(value: string): { title: string; sidebar: boolean; section: ResumeLayoutSection } | undefined {
  const normalized = value.trim().replace(/[:\s]+$/, "").toLocaleLowerCase("pt-BR");
  const patterns: Array<[RegExp, string, boolean, ResumeLayoutSection]> = [
    [/^(?:contato|contact|informa[cç][oõ]es de contato)$/, "Contato", true, "contact"],
    [/^(?:forma[cç][aã]o|educa[cç][aã]o|forma[cç][aã]o acad[eê]mica|education)$/, "Formação", true, "education"],
    [/^(?:habilidades|compet[eê]ncias|skills|conhecimentos|ferramentas|tecnologias|technical skills|tools)$/, "Competências", true, "skills"],
    [/^(?:idiomas|l[ií]nguas|languages)$/, "Idiomas", true, "languages"],
    [/^(?:resumo|perfil|sobre mim|objetivo|summary|profile)$/, "Resumo profissional", false, "summary"],
    [/^(?:experi[eê]ncia|experi[eê]ncia profissional|hist[oó]rico profissional|experience|work experience)$/, "Experiência profissional", false, "experience"],
    [/^(?:certifica[cç][oõ]es|cursos|cursos e certifica[cç][oõ]es|certifications)$/, "Certificações e cursos", false, "certifications"],
    [/^(?:projetos|publica[cç][oõ]es|voluntariado|prêmios|premios)$/, value.trim(), false, "projects"],
  ];
  const found = patterns.find(([pattern]) => pattern.test(normalized));
  if (found) return { title: found[1], sidebar: found[2], section: found[3] };
  const letters = value.replace(/[^\p{L}]/gu, "");
  if (value.trim().length > 2 && value.trim().length <= 72 && letters.length > 2 && letters === letters.toLocaleUpperCase("pt-BR")) {
    return { title: value.trim(), sidebar: false, section: "other" };
  }
  return undefined;
}

function comparableText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isContactLine(value: string): boolean {
  return /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d ()-]{7,}\d)|(?:https?:\/\/|www\.)\S+|linkedin\.com|github\.com|,\s*[A-Z]{2}\b)/iu.test(value);
}

async function preflight(pdf: Buffer, sourceText: string): Promise<void> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = fileURLToPath(new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));
  let parsed: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]> | undefined;
  try {
    parsed = await pdfjs.getDocument({
      data: new Uint8Array(pdf),
      isEvalSupported: false,
      useSystemFonts: true,
      standardFontDataUrl,
    }).promise;
    if (parsed.numPages < 1 || parsed.numPages > RESUME_LAYOUT_LIMITS.maximumRenderedPages) throw new Error("invalid_page_count");
    let outputText = "";
    for (let pageNumber = 1; pageNumber <= parsed.numPages; pageNumber += 1) {
      const page = await parsed.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is typeof item & { str: string; transform: number[]; width: number; height: number } =>
        "str" in item && typeof item.str === "string" && "transform" in item && Array.isArray(item.transform));
      if (items.length === 0) throw new Error("empty_page");
      const width = page.view[2] - page.view[0];
      const height = page.view[3] - page.view[1];
      for (const item of items) {
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < -2 || x + Math.max(0, item.width) > width + 3 || y < -2 || y > height + 3) {
          throw new Error("text_outside_page");
        }
      }
      outputText += `${items.map((item) => item.str).join(" ")} `;
    }
    if (comparableText(outputText) !== comparableText(sourceText)) throw new Error("resume_text_changed");
  } catch {
    throw new ResumeLayoutError("render_failed");
  } finally {
    try { await parsed?.destroy(); } catch { /* Keep the rendering failure bounded. */ }
  }
}

async function renderLegacyLayoutTextResumePdf(template: ResumeLayoutTemplateV2, resumeText: string): Promise<Buffer> {
  if (!resumeText.trim() || Array.from(resumeText).length > 80_000) throw new ResumeLayoutError("render_failed");
  const sourceLines = resumeText.replace(/\r\n?/g, "\n").split("\n");
  const nameIndex = sourceLines.findIndex((line) => line.trim().length > 0);
  const name = nameIndex >= 0 ? sourceLines[nameIndex]! : "";
  const headerName = Array.from(name).length <= 120 ? name : "";
  const sidebarWidth = Math.max(135, Math.min(210, template.columns.sidebarWidthPt));
  const gutter = Math.max(14, Math.min(30, template.columns.gapPt));
  const margin = Math.max(24, Math.min(48, template.page.marginPt));
  const mainX = sidebarWidth + gutter;
  const mainWidth = PAGE_WIDTH - mainX - margin;
  const bodyFontSize = Math.max(9, Math.min(12, template.typography.bodyPt));

  const document = new PDFDocument({
    size: "A4",
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    autoFirstPage: false,
    info: { Title: "Currículo revisado", Creator: "Curriculus" },
  });
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.once("error", () => reject(new ResumeLayoutError("render_failed")));
    document.once("end", () => resolve(Buffer.concat(chunks)));
  });

  let pageNumber = 0;
  let cursorY = 0;
  let sidebarY = 38;
  const addPage = () => {
    if (pageNumber >= RESUME_LAYOUT_LIMITS.maximumRenderedPages) throw new ResumeLayoutError("render_failed");
    document.addPage({ size: "A4" });
    pageNumber += 1;
    document.rect(0, 0, sidebarWidth, PAGE_HEIGHT).fill(template.palette.sidebar);
    sidebarY = 38;
    if (pageNumber === 1) {
      document.rect(sidebarWidth, 0, PAGE_WIDTH - sidebarWidth, template.header.heightPt).fill(template.palette.headerApprox);
      let fontSize = Math.max(20, Math.min(30, template.typography.namePt));
      let nameLines = wrapPdfText(document, headerName, mainWidth - 12, "Helvetica-Bold", fontSize);
      while (nameLines.length > 4 && fontSize > 12) {
        fontSize -= 1;
        nameLines = wrapPdfText(document, headerName, mainWidth - 12, "Helvetica-Bold", fontSize);
      }
      nameLines.forEach((line, index) => {
        document.font("Helvetica-Bold").fontSize(fontSize).fillColor("#16342E")
          .text(line, mainX, 34 + index * fontSize * 1.35, { width: mainWidth - 12, lineBreak: false });
      });
      cursorY = Math.max(template.header.heightPt, 140) + 28;
    } else {
      cursorY = 42;
    }
  };
  const ensureSpace = (height: number) => {
    if (cursorY + height > PAGE_BOTTOM) addPage();
  };
  const drawSidebarLine = (value: string, heading: boolean) => {
    if (!value.trim()) { sidebarY += 5; return; }
    const font = heading ? "Helvetica-Bold" : "Helvetica";
    const fontSize = heading ? 8.5 : 8.7;
    const lineHeight = fontSize * 1.4;
    const lines = wrapPdfText(document, value.trim(), sidebarWidth - 40, font, fontSize);
    if (heading) sidebarY += sidebarY > 42 ? 9 : 0;
    for (const line of lines) {
      if (sidebarY + lineHeight > PAGE_BOTTOM) addPage();
      document.font(font).fontSize(fontSize).fillColor(heading ? "#D2DED9" : "#FFFFFF")
        .text(line, 20, sidebarY, { width: sidebarWidth - 40, lineBreak: false });
      sidebarY += lineHeight;
    }
    sidebarY += heading ? 5 : 2;
  };
  const drawBodyLine = (value: string, options: { heading?: boolean; indent?: number } = {}) => {
    if (!value.trim()) { cursorY += 7; return; }
    const isBullet = /^\s*(?:[-*•]|\d+[.)])\s+/.test(value);
    const heading = options.heading ?? false;
    const indent = options.indent ?? (isBullet ? 9 : 0);
    const font = heading ? "Helvetica-Bold" : "Helvetica";
    const fontSize = heading ? Math.max(11, Math.min(15, template.typography.sectionPt)) : bodyFontSize;
    const lineHeight = fontSize * 1.42;
    const lines = wrapPdfText(document, value.trim(), mainWidth - indent, font, fontSize);
    if (heading) {
      ensureSpace(lineHeight + 28);
      cursorY += cursorY > 170 ? 11 : 0;
    }
    for (const line of lines) {
      ensureSpace(lineHeight);
      document.font(font).fontSize(fontSize).fillColor(heading ? "#246B58" : template.palette.text)
        .text(line, mainX + indent, cursorY, { width: mainWidth - indent, lineBreak: false });
      cursorY += lineHeight;
    }
    if (heading) {
      document.moveTo(mainX, cursorY + 2).lineTo(mainX + mainWidth, cursorY + 2).lineWidth(0.6).strokeColor("#D6E3DC").stroke();
      cursorY += 12;
    } else {
      cursorY += 2;
    }
  };

  try {
    addPage();
    let useSidebar = false;
    for (let index = 0; index < sourceLines.length; index += 1) {
      if (index === nameIndex && headerName) continue;
      const line = sourceLines[index]!;
      const heading = headingKind(line);
      if (heading) useSidebar = heading.sidebar;
      if (useSidebar) drawSidebarLine(line, Boolean(heading));
      else drawBodyLine(line, { heading: Boolean(heading) });
    }
    document.end();
  } catch (error) {
    document.destroy();
    throw error instanceof ResumeLayoutError ? error : new ResumeLayoutError("render_failed");
  }

  const pdf = await output;
  if (pdf.length > 10 * 1024 * 1024) throw new ResumeLayoutError("render_failed");
  await preflight(pdf, resumeText);
  return pdf;
}

function boundedNumber(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function safeColor(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function fontName(family: ResumeLayoutFontFamily, bold: boolean): string {
  if (family === "Times-Roman") return bold ? "Times-Bold" : "Times-Roman";
  if (family === "Courier") return bold ? "Courier-Bold" : "Courier";
  return bold ? "Helvetica-Bold" : "Helvetica";
}

function luminance(color: string): number {
  const channels = color.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16)) ?? [255, 255, 255];
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastColor(background: string): string {
  return luminance(background) < 140 ? "#FFFFFF" : "#171A19";
}

async function renderAdaptiveLayoutTextResumePdf(template: ResumeLayoutTemplateV3, resumeText: string): Promise<Buffer> {
  if (!resumeText.trim() || Array.from(resumeText).length > 80_000) throw new ResumeLayoutError("render_failed");
  const sourceLines = resumeText.replace(/\r\n?/g, "\n").split("\n");
  const nameIndex = sourceLines.findIndex((line) => line.trim().length > 0);
  const headerName = nameIndex >= 0 ? sourceLines[nameIndex]!.trim() : "";
  const pageWidth = boundedNumber(template.page.widthPt, PAGE_WIDTH, 220, 2_000);
  const pageHeight = boundedNumber(template.page.heightPt, PAGE_HEIGHT, 300, 3_000);
  const margin = boundedNumber(template.page.marginPt, 30, 10, Math.min(100, pageWidth * 0.2));
  const sidebarWidth = template.columns.count === 2
    ? boundedNumber(template.columns.sidebarWidthPt, 150, 60, pageWidth * 0.52)
    : 0;
  const gap = template.columns.count === 2
    ? boundedNumber(template.columns.gapPt, 18, 6, Math.min(56, pageWidth * 0.12))
    : 0;
  const mainX = boundedNumber(template.columns.mainXPt, margin, 0, pageWidth - 80);
  const mainWidth = boundedNumber(template.columns.mainWidthPt, pageWidth - mainX - margin, 70, pageWidth - mainX);
  const bodyFontSize = boundedNumber(template.typography.bodyPt, 10.5, 7, 16);
  const sectionFontSize = boundedNumber(template.typography.sectionPt, bodyFontSize + 2, bodyFontSize, 24);
  const nameFontSize = boundedNumber(template.typography.namePt, 22, 12, 42);
  const bodyColor = safeColor(template.visual.bodyTextColor, safeColor(template.palette.text, "#202725"));
  const headingColor = safeColor(template.visual.headingTextColor, safeColor(template.palette.headerApprox, "#246B58"));
  const sidebarRegion = template.visual.regions.find((region) => region.role === "sidebar");
  const headerRegion = template.visual.regions.find((region) => region.role === "header");
  const sidebarFill = sidebarRegion ? safeColor(sidebarRegion.color, "#FFFFFF") : "#FFFFFF";
  const mainStartY = headerRegion
    ? Math.max(margin, headerRegion.y + headerRegion.height + 12)
    : Math.max(
      margin,
      template.visual.contentBounds.y,
      template.header.nameRegion === "main" ? template.header.nameYPt + nameFontSize * 1.45 + 8 : 0,
    );
  const contentTop = Math.max(margin, template.visual.contentBounds.y);
  const pageBottom = pageHeight - margin;
  const sidebarX = template.columns.count === 2
    ? boundedNumber(template.columns.sidebarXPt, 0, 0, pageWidth - sidebarWidth)
    : 0;
  const sideTextColor = sidebarRegion
    ? (luminance(sidebarFill) < 145 ? "#FFFFFF" : bodyColor)
    : bodyColor;
  const sideHeadingColor = sidebarRegion
    ? (luminance(sidebarFill) < 145 ? "#E6ECE9" : headingColor)
    : headingColor;

  const document = new PDFDocument({
    size: [pageWidth, pageHeight],
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    autoFirstPage: false,
    info: { Title: "Currículo revisado", Creator: "Curriculus" },
  });
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.once("error", () => reject(new ResumeLayoutError("render_failed")));
    document.once("end", () => resolve(Buffer.concat(chunks)));
  });

  let pageNumber = 0;
  let cursorY = contentTop;
  let sidebarY = contentTop;
  let headerContactY: number | undefined;
  const drawRegions = (currentPage: number) => {
    for (const region of template.visual.regions) {
      if (region.pageNumber !== 1 && !region.repeatOnPages) continue;
      if (currentPage > 1 && !region.repeatOnPages) continue;
      const x = boundedNumber(region.x, 0, 0, pageWidth);
      const y = boundedNumber(region.y, 0, 0, pageHeight);
      const width = boundedNumber(region.width, 0, 0, pageWidth - x);
      const height = boundedNumber(region.height, 0, 0, pageHeight - y);
      if (width < 1 || height < 1) continue;
      document.rect(x, y, width, height).fill(safeColor(region.color, "#FFFFFF"));
    }
  };
  const addPage = () => {
    if (pageNumber >= RESUME_LAYOUT_LIMITS.maximumRenderedPages) throw new ResumeLayoutError("render_failed");
    document.addPage({ size: [pageWidth, pageHeight], margins: { top: 0, right: 0, bottom: 0, left: 0 } });
    pageNumber += 1;
    drawRegions(pageNumber);
    cursorY = pageNumber === 1 ? mainStartY : contentTop;
    sidebarY = contentTop;

    if (pageNumber !== 1 || !headerName) return;
    let currentNameSize = nameFontSize;
    const nameIsSidebar = template.columns.count === 2 && template.header.nameRegion === "sidebar";
    const sidebarPad = Math.min(18, Math.max(9, sidebarWidth * 0.1));
    const mainRight = mainX + mainWidth;
    const nameUsesRegionAlignment = template.header.nameAlignment !== "left";
    const headerX = nameIsSidebar
      ? boundedNumber(nameUsesRegionAlignment ? sidebarX + sidebarPad : template.header.nameXPt,
        sidebarX + sidebarPad, sidebarX + 4, sidebarX + sidebarWidth - 40)
      : boundedNumber(nameUsesRegionAlignment ? mainX : template.header.nameXPt,
        mainX, mainX, Math.max(mainX, mainRight - 70));
    const headerWidth = nameIsSidebar
      ? Math.max(48, sidebarWidth - sidebarPad * 2)
      : Math.max(70, Math.min(mainX + mainWidth - headerX, pageWidth - headerX - margin));
    const nameFont = fontName(template.typography.nameFont, template.typography.nameWeight === "bold");
    let nameLines = wrapPdfText(document, headerName, headerWidth, nameFont, currentNameSize);
    while (nameLines.length > 4 && currentNameSize > 12) {
      currentNameSize -= 1;
      nameLines = wrapPdfText(document, headerName, headerWidth, nameFont, currentNameSize);
    }
    const headerY = boundedNumber(
      template.header.nameYPt,
      headerRegion ? headerRegion.y + 18 : template.visual.contentBounds.y,
      0,
      pageHeight - currentNameSize,
    );
    nameLines.forEach((line, index) => {
      document.font(nameFont).fontSize(currentNameSize)
        .fillColor(safeColor(template.header.nameTextColor, contrastColor(safeColor(template.palette.headerApprox, "#FFFFFF"))))
        .text(line, headerX, headerY + index * currentNameSize * 1.25, {
          width: headerWidth,
          align: template.header.nameAlignment,
          lineBreak: false,
        });
    });
    const nameBottom = headerY + nameLines.length * currentNameSize * 1.35 + 8;
    headerContactY = nameBottom;
    if (!headerRegion && template.header.nameRegion === "main") cursorY = Math.max(cursorY, nameBottom);
    if (nameIsSidebar) sidebarY = Math.max(sidebarY, nameBottom);
  };
  const ensureSpace = (region: "main" | "sidebar", height: number) => {
    const y = region === "sidebar" ? sidebarY : cursorY;
    if (y + height > pageBottom) addPage();
  };
  const drawMainLine = (value: string, heading: boolean) => {
    if (!value.trim()) {
      cursorY += template.visual.paragraphGapPt + 5;
      return;
    }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/.test(value);
    const indent = bullet ? Math.min(12, bodyFontSize) : 0;
    const size = heading ? sectionFontSize : bodyFontSize;
    const font = fontName(
      heading ? template.typography.headingFont : template.typography.bodyFont,
      heading ? template.typography.headingWeight === "bold" : template.typography.bodyWeight === "bold",
    );
    const lineHeight = size * (heading ? 1.28 : boundedNumber(template.visual.bodyLineHeightRatio, 1.4, 1.05, 1.9));
    const lines = wrapPdfText(document, value.trim(), Math.max(60, mainWidth - indent), font, size);
    if (heading) {
      ensureSpace("main", lineHeight * (Math.min(lines.length, 2) + 1) + 14);
      cursorY += cursorY > mainStartY + 10 ? template.visual.paragraphGapPt + 5 : 0;
    }
    for (const line of lines) {
      ensureSpace("main", lineHeight);
      document.font(font).fontSize(size).fillColor(heading ? headingColor : bodyColor)
        .text(line, mainX + indent, cursorY, { width: Math.max(60, mainWidth - indent), lineBreak: false });
      cursorY += lineHeight;
    }
    if (heading) {
      document.moveTo(mainX, cursorY + 2).lineTo(mainX + mainWidth, cursorY + 2)
        .lineWidth(0.55).strokeColor(safeColor(template.palette.headerApprox, "#D6E3DC")).stroke();
      cursorY += template.visual.paragraphGapPt + 7;
    } else cursorY += template.visual.paragraphGapPt;
  };
  const drawSidebarLine = (value: string, heading: boolean) => {
    if (!value.trim()) {
      sidebarY += template.visual.paragraphGapPt + 4;
      return;
    }
    let size = heading ? Math.max(8.5, Math.min(13, sectionFontSize - 1)) : Math.max(8, Math.min(12, bodyFontSize));
    const font = fontName(
      heading ? template.typography.headingFont : template.typography.bodyFont,
      heading ? template.typography.headingWeight === "bold" : template.typography.bodyWeight === "bold",
    );
    const lineHeight = size * boundedNumber(template.visual.bodyLineHeightRatio, 1.4, 1.05, 1.8);
    const innerPad = Math.min(18, Math.max(9, sidebarWidth * 0.1));
    const textX = sidebarX + innerPad;
    const textWidth = Math.max(48, sidebarWidth - innerPad * 2);
    while (!heading && size > 7 && value.trim().split(/\s+/u).some((word) =>
      document.font(font).fontSize(size).widthOfString(word) > textWidth,
    )) size = Math.max(7, size - 0.5);
    const lines = wrapPdfText(document, value.trim(), textWidth, font, size);
    if (heading) {
      ensureSpace("sidebar", lineHeight * (Math.min(lines.length, 2) + 1) + 10);
      sidebarY += sidebarY > contentTop + 6 ? template.visual.paragraphGapPt + 3 : 0;
    }
    for (const line of lines) {
      ensureSpace("sidebar", lineHeight);
      document.font(font).fontSize(size).fillColor(heading ? sideHeadingColor : sideTextColor)
        .text(line, textX, sidebarY, { width: textWidth, lineBreak: false });
      sidebarY += lineHeight;
    }
    sidebarY += template.visual.paragraphGapPt;
  };
  const drawHeaderContactLine = (value: string): boolean => {
    if (!headerRegion || headerContactY === undefined || pageNumber !== 1) return false;
    const padding = Math.min(18, Math.max(9, headerRegion.width * 0.035));
    const textX = Math.max(headerRegion.x + padding, template.header.nameXPt);
    const textWidth = Math.max(60, headerRegion.x + headerRegion.width - padding - textX);
    const size = Math.max(8, Math.min(10, bodyFontSize));
    const font = fontName(template.typography.bodyFont, template.typography.bodyWeight === "bold");
    const lineHeight = size * 1.25;
    const lines = wrapPdfText(document, value.trim(), textWidth, font, size);
    const neededHeight = lines.length * lineHeight;
    if (headerContactY + neededHeight > headerRegion.y + headerRegion.height - padding * 0.4) return false;
    for (const line of lines) {
      document.font(font).fontSize(size).fillColor(bodyColor)
        .text(line, textX, headerContactY, { width: textWidth, lineBreak: false });
      headerContactY += lineHeight;
    }
    headerContactY += Math.max(1, template.visual.paragraphGapPt * 0.35);
    return true;
  };

  try {
    addPage();
    const placements = new Map(template.visual.sectionPlacements.map((entry) => [entry.section, entry]));
    let activeRegion: "main" | "sidebar" = "main";
    let initialContactOpen = template.header.contactRegion === "header" || template.header.contactRegion === "sidebar";
    let initialContactCount = 0;
    for (let index = 0; index < sourceLines.length; index += 1) {
      if (index === nameIndex && headerName) continue;
      const line = sourceLines[index]!;
      const heading = headingKind(line);
      if (heading) {
        initialContactOpen = false;
        const placement = placements.get(heading.section);
        while (placement?.pageNumber !== undefined && placement.pageNumber > pageNumber) addPage();
        activeRegion = template.columns.count === 2 && (placement?.region === "sidebar" || (!placement && heading.sidebar))
          ? "sidebar"
          : "main";
        if (placement?.pageNumber === pageNumber && Number.isFinite(placement.yPt)) {
          const anchorY = boundedNumber(placement.yPt!, contentTop, contentTop, pageHeight - bodyFontSize * 2);
          if (activeRegion === "sidebar") sidebarY = Math.max(sidebarY, anchorY);
          else cursorY = Math.max(cursorY, anchorY);
        }
      }
      if (!heading && initialContactOpen && line.trim() && initialContactCount < 4 && isContactLine(line)) {
        initialContactCount += 1;
        if (template.header.contactRegion === "header" && drawHeaderContactLine(line)) continue;
        if (template.columns.count === 2 && template.header.contactRegion === "sidebar") {
          drawSidebarLine(line, false);
          continue;
        }
      } else if (line.trim()) {
        initialContactOpen = false;
      }
      if (activeRegion === "sidebar" && template.columns.count === 2) drawSidebarLine(line, Boolean(heading));
      else drawMainLine(line, Boolean(heading));
    }
    document.end();
  } catch (error) {
    document.destroy();
    throw error instanceof ResumeLayoutError ? error : new ResumeLayoutError("render_failed");
  }

  const pdf = await output;
  if (pdf.length > 10 * 1024 * 1024) throw new ResumeLayoutError("render_failed");
  await preflight(pdf, resumeText);
  return pdf;
}

export async function renderLayoutTextResumePdf(template: ResumeLayoutTemplate, resumeText: string): Promise<Buffer> {
  return template.schemaVersion === "3.0"
    ? renderAdaptiveLayoutTextResumePdf(template, resumeText)
    : renderLegacyLayoutTextResumePdf(template, resumeText);
}
