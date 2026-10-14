import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import type { ResumeLayoutTemplate } from "./resume-layout-types.js";
import { ResumeLayoutError } from "./resume-layout-errors.js";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const PAGE_BOTTOM = 802;

function wrapPdfText(
  document: PDFKit.PDFDocument,
  value: string,
  maximumWidth: number,
  font: "Helvetica" | "Helvetica-Bold",
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

function headingKind(value: string): { title: string; sidebar: boolean } | undefined {
  const normalized = value.trim().replace(/[:\s]+$/, "").toLocaleLowerCase("pt-BR");
  const patterns: Array<[RegExp, string, boolean]> = [
    [/^(?:contato|contact|informa[cç][oõ]es de contato)$/, "Contato", true],
    [/^(?:forma[cç][aã]o|educa[cç][aã]o|forma[cç][aã]o acad[eê]mica|education)$/, "Formação", true],
    [/^(?:habilidades|compet[eê]ncias|skills|conhecimentos)$/, "Competências", true],
    [/^(?:idiomas|l[ií]nguas|languages)$/, "Idiomas", true],
    [/^(?:resumo|perfil|sobre mim|objetivo|summary|profile)$/, "Resumo profissional", false],
    [/^(?:experi[eê]ncia|experi[eê]ncia profissional|hist[oó]rico profissional|experience|work experience)$/, "Experiência profissional", false],
    [/^(?:certifica[cç][oõ]es|cursos|cursos e certifica[cç][oõ]es|certifications)$/, "Certificações e cursos", false],
    [/^(?:projetos|publica[cç][oõ]es|voluntariado|prêmios|premios)$/, value.trim(), false],
  ];
  const found = patterns.find(([pattern]) => pattern.test(normalized));
  if (found) return { title: found[1], sidebar: found[2] };
  const letters = value.replace(/[^\p{L}]/gu, "");
  if (value.trim().length > 2 && value.trim().length <= 72 && letters.length > 2 && letters === letters.toLocaleUpperCase("pt-BR")) {
    return { title: value.trim(), sidebar: false };
  }
  return undefined;
}

function comparableText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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
    if (parsed.numPages < 1 || parsed.numPages > 30) throw new Error("invalid_page_count");
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

export async function renderLayoutTextResumePdf(template: ResumeLayoutTemplate, resumeText: string): Promise<Buffer> {
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
    if (pageNumber >= 30) throw new ResumeLayoutError("render_failed");
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
