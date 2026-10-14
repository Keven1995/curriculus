import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import PDFDocument from "pdfkit";
import test from "node:test";
import { createApp } from "../app.js";
import { extractPdfLayout } from "./pdf-layout-extractor.js";
import { ResumeLayoutError } from "./resume-layout-errors.js";
import { ResumeLayoutService } from "./resume-layout-service.js";
import type { ResumeLayoutTemplateStore } from "./resume-layout-store.js";
import type { ResumeLayoutTemplate } from "./resume-layout-types.js";
import { renderLayoutTextResumePdf } from "./layout-text-pdf-renderer.js";

async function createReferencePdf(includeText = true): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(document, "end").then(() => Buffer.concat(chunks));
  document.rect(0, 0, 170, 841.89).fill("#354550");
  document.rect(170, 0, 425, 140).fill("#BACD9E");
  if (includeText) {
    document.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(15).text("NOME DA REFERÊNCIA", 24, 60, { width: 135 });
    document.fillColor("#111111").font("Helvetica-Bold").fontSize(20).text("PERFIL PROFISSIONAL", 212, 46, { width: 340 });
    document.font("Helvetica").fontSize(11).text("Experiência com conteúdo de exemplo", 212, 180, { width: 340 });
    document.font("Helvetica-Bold").fontSize(12).text("FORMAÇÃO", 25, 220, { width: 130 });
  }
  document.end();
  return ended;
}

async function createTwoColumnResumePdf(): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(document, "end").then(() => Buffer.concat(chunks));
  document.font("Helvetica").fontSize(11).text("Trabalhei com Java para construir", 24, 60, { width: 135 });
  document.font("Helvetica").fontSize(11).text("APIs REST.", 24, 78, { width: 135 });
  document.font("Helvetica").fontSize(11).text("Tenho experiencia com", 212, 60, { width: 340 });
  document.font("Helvetica").fontSize(11).text("documentacao tecnica.", 212, 78, { width: 340 });
  document.end();
  return ended;
}

async function createSingleColumnResumePdf(): Promise<Buffer> {
  const document = new PDFDocument({ size: [612, 792], margin: 0 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(document, "end").then(() => Buffer.concat(chunks));
  document.rect(36, 24, 540, 100).fill("#D9E7F3");
  document.fillColor("#17324D").font("Times-Bold").fontSize(24).text("Marina Exemplo", 52, 54);
  document.fillColor("#273746").font("Times-Roman").fontSize(11)
    .text("marina@example.test | São Paulo, SP", 52, 86, { width: 480 });
  document.fillColor("#273746").font("Times-Roman").fontSize(12).text("RESUMO", 52, 158);
  document.font("Times-Roman").fontSize(11).text("Profissional com experiência em produtos digitais.", 52, 182);
  document.fillColor("#1F5A44").font("Times-Bold").fontSize(14).text("EXPERIÊNCIA", 52, 238);
  document.end();
  return ended;
}

async function createRightSidebarResumePdf(): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(document, "end").then(() => Buffer.concat(chunks));
  document.rect(0, 0, 438, 116).fill("#E8DDF0");
  document.rect(440, 0, 155.28, 841.89).fill("#4C5540");
  document.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(15)
    .text("Juliana Moraes", 456, 58, { width: 124 });
  document.fillColor("#E8ECE4").font("Helvetica-Bold").fontSize(10)
    .text("CONTATO", 456, 158, { width: 124 });
  document.fillColor("#FFFFFF").font("Helvetica").fontSize(9)
    .text("juliana@example.test", 456, 180, { width: 124 });
  document.fillColor("#26313A").font("Helvetica-Bold").fontSize(19)
    .text("ANALISTA DE DADOS", 34, 44, { width: 380 });
  document.fillColor("#26313A").font("Helvetica-Bold").fontSize(12).text("FERRAMENTAS", 456, 236);
  document.fillColor("#FFFFFF").font("Helvetica").fontSize(9).text("SQL", 456, 258);
  document.fillColor("#26313A").font("Helvetica-Bold").fontSize(12).text("EXPERIÊNCIA", 34, 160);
  document.fillColor("#202725").font("Helvetica").fontSize(10.5)
    .text("Analista de Dados — Empresa Exemplo", 34, 184, { width: 370 });
  document.end();
  return ended;
}

async function createAmbiguousRepeatedTitlePdf(): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(document, "end").then(() => Buffer.concat(chunks));
  const drawPage = (pageNumber: number) => {
    document.rect(0, 0, 164, 841.89).fill("#354550");
    if (pageNumber === 1) document.rect(164, 0, 431, 128).fill("#BACD9E");
    document.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(15).text("Marina Exemplo", 22, 54, { width: 128 });
    document.fillColor("#182B2A").font("Helvetica-Bold").fontSize(18)
      .text(pageNumber === 1 ? "ENGENHEIRA DE SOFTWARE" : "DIRETORA DE ENGENHARIA", 192, 44, { width: 370 });
    document.fillColor("#202725").font("Helvetica-Bold").fontSize(12).text("EXPERIÊNCIA PROFISSIONAL", 192, 170);
    document.font("Helvetica").fontSize(10.5)
      .text(pageNumber === 1 ? "Liderei sistemas de produção." : "Gerenciei equipes de engenharia.", 192, 194, { width: 365 });
  };
  drawPage(1);
  document.addPage({ size: "A4", margin: 0 });
  drawPage(2);
  document.end();
  return ended;
}

async function createMultiPageReferencePdf(): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(document, "end").then(() => Buffer.concat(chunks));
  const drawPage = (pageNumber: number) => {
    document.rect(0, 0, 164, 841.89).fill("#354550");
    if (pageNumber === 1) document.rect(164, 0, 431, 128).fill("#BACD9E");
    document.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(15)
      .text("Marina Exemplo", 22, 54, { width: 128 });
    document.fillColor("#111111").font("Helvetica-Bold").fontSize(18)
      .text(pageNumber === 1 ? "CURRÍCULO" : "CONTINUAÇÃO", 204, 46, { width: 350 });
    document.font("Helvetica").fontSize(11)
      .text(pageNumber === 1 ? "EXPERIÊNCIA PROFISSIONAL" : "PROJETOS E RESULTADOS", 204, 170, { width: 350 });
    document.text(`Conteúdo de referência da página ${pageNumber}.`, 204, 198, { width: 350 });
    document.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(11)
      .text(pageNumber === 1 ? "CONTATO" : "COMPETÊNCIAS", 22, 200, { width: 128 });
    document.fillColor("#FFFFFF").font("Helvetica").fontSize(10)
      .text(pageNumber === 1 ? "marina@example.test" : "TypeScript", 22, 222, { width: 128 });
    if (pageNumber === 2) {
      document.fillColor("#111111").font("Helvetica-Bold").fontSize(12).text("FORMAÇÃO", 204, 250);
      document.font("Helvetica").fontSize(10.5).text("Engenharia de Produção — Instituto Exemplo", 204, 273, { width: 350 });
    }
  };
  drawPage(1);
  document.addPage({ size: "A4", margin: 0 });
  drawPage(2);
  document.end();
  return ended;
}

async function rasterizePdfPage(bytes: Buffer, pageNumber = 1): Promise<{
  width: number;
  height: number;
  pixels: Uint8Array;
}> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = fileURLToPath(new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));
  const parsed = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;
  try {
    const page = await parsed.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  } finally {
    await parsed.destroy();
  }
}

async function readPdfTextGeometry(bytes: Buffer): Promise<Array<{
  pageNumber: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}>> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = fileURLToPath(new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));
  const parsed = await pdfjs.getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, standardFontDataUrl,
  }).promise;
  const result: Array<{ pageNumber: number; text: string; x: number; y: number; width: number; height: number }> = [];
  try {
    for (let pageNumber = 1; pageNumber <= parsed.numPages; pageNumber += 1) {
      const page = await parsed.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        result.push({
          pageNumber,
          text: item.str,
          x: item.transform[4]!,
          y: viewport.height - item.transform[5]! - item.height,
          width: item.width,
          height: item.height,
        });
      }
    }
    return result;
  } finally {
    await parsed.destroy();
  }
}

function regionPixels(
  page: { width: number; pixels: Uint8Array },
  x: number,
  y: number,
  width: number,
  height: number,
): number[] {
  const values: number[] = [];
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = (row * page.width + column) * 4;
      values.push(page.pixels[offset]!, page.pixels[offset + 1]!, page.pixels[offset + 2]!);
    }
  }
  return values;
}

class MemoryResumeLayoutStore implements ResumeLayoutTemplateStore {
  private readonly templates = new Map<string, { template: ResumeLayoutTemplate; expiresAt: Date }>();

  constructor(private readonly now: () => number = Date.now) {}

  async storeTemporaryResumeLayout(templateId: string, template: ResumeLayoutTemplate): Promise<Date> {
    const expiresAt = new Date(this.now() + 24 * 60 * 60_000);
    this.templates.set(templateId, { template: structuredClone(template), expiresAt });
    return expiresAt;
  }

  async findTemporaryResumeLayout(templateId: string): Promise<ResumeLayoutTemplate | null> {
    const stored = this.templates.get(templateId);
    if (!stored || stored.expiresAt.getTime() <= this.now()) return null;
    return structuredClone(stored.template);
  }

  async deleteTemporaryResumeLayout(templateId: string): Promise<boolean> {
    return this.templates.delete(templateId);
  }

  async deleteExpiredTemporaryResumeLayouts(): Promise<number> {
    let deleted = 0;
    for (const [id, stored] of this.templates) {
      if (stored.expiresAt.getTime() > this.now()) continue;
      this.templates.delete(id);
      deleted += 1;
    }
    return deleted;
  }
}

test("extracts bounded technical text/layout JSON and detects headings without retaining the source PDF", async () => {
  const bytes = await createReferencePdf();
  const extracted = await extractPdfLayout(bytes, "C:\\private\\referencia.pdf");

  assert.equal(extracted.rawExtraction.schema_version, "1.1");
  assert.equal(extracted.rawExtraction.source_file.name, "referencia.pdf");
  assert.equal(extracted.rawExtraction.usage.source_pdf_retained, false);
  assert.equal(extracted.rawExtraction.usage.ocr, false);
  assert.equal(extracted.rawExtraction.pages.length, 1);
  assert.ok(extracted.rawExtraction.pages[0]!.text_blocks.length >= 3);
  assert.ok(extracted.rawExtraction.pages[0]!.text_blocks.some((block) => block.text.includes("NOME DA")));
  assert.ok(extracted.rawExtraction.pages[0]!.text_blocks.some((block) => block.text.includes("REFERÊNCIA")));
  assert.equal(extracted.resumeText, "NOME DA\nREFERÊNCIA\nPERFIL PROFISSIONAL\nExperiência com conteúdo de exemplo\nFORMAÇÃO");
  assert.equal(extracted.layoutAvailable, true);
  assert.ok(extracted.detectedSections.some((section) => section.label === "Formação"));
  assert.equal(extracted.template.schemaVersion, "3.0");
  assert.equal(extracted.template.id, "adaptive-resume-layout-v1");
  assert.equal(extracted.template.palette.sidebar, "#354550");
  assert.equal(extracted.template.palette.headerApprox, "#BACD9E");
  assert.ok(extracted.template.visual.regions.some((region) => region.role === "sidebar" && region.color === "#354550"));
  assert.ok(extracted.template.visual.regions.some((region) => region.role === "header" && region.color === "#BACD9E"));
  assert.equal(extracted.rawExtraction.images.bytes_extracted, false);
  assert.equal(extracted.rawExtraction.images.reused_in_output, false);
});

test("rejects invalid, scanned, oversized and over-paginated reference PDFs safely", async () => {
  await assert.rejects(extractPdfLayout(Buffer.from("not a PDF"), "bad.pdf"), (error: unknown) =>
    error instanceof ResumeLayoutError && error.code === "invalid_pdf");
  await assert.rejects(
    extractPdfLayout(Buffer.alloc(10 * 1024 * 1024 + 1), "large.pdf"),
    (error: unknown) => error instanceof ResumeLayoutError && error.code === "file_too_large",
  );
  await assert.rejects(
    extractPdfLayout(await createReferencePdf(false), "scan.pdf"),
    (error: unknown) => error instanceof ResumeLayoutError && error.code === "no_selectable_text",
  );

  const manyPages = new PDFDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];
  manyPages.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = once(manyPages, "end").then(() => Buffer.concat(chunks));
  for (let index = 0; index < 31; index += 1) manyPages.addPage().fontSize(10).text("Página de teste");
  manyPages.end();
  await assert.rejects(
    extractPdfLayout(await ended, "pages.pdf"),
    (error: unknown) => error instanceof ResumeLayoutError && error.code === "too_many_pages",
  );
});

test("detects separate columns even when both columns have text on the same baselines", async () => {
  const extracted = await extractPdfLayout(await createTwoColumnResumePdf(), "two-column.pdf");

  assert.equal(extracted.template.detection.detectedColumns, 2);
  assert.equal(extracted.template.columns.count, 2);
  assert.equal(extracted.layoutAvailable, true);
  assert.equal(extracted.resumeText.replace(/\s+/gu, " ").trim(), "Trabalhei com Java para construir APIs REST. Tenho experiencia com documentacao tecnica.");
});

test("extracts one-column page size, visual hierarchy, font families, text colors, and a stable header region", async () => {
  const extracted = await extractPdfLayout(await createSingleColumnResumePdf(), "one-column-letter.pdf");

  assert.equal(extracted.template.page.format, "custom");
  assert.equal(extracted.template.page.widthPt, 612);
  assert.equal(extracted.template.page.heightPt, 792);
  assert.equal(extracted.template.columns.count, 1);
  assert.equal(extracted.template.detection.detectedColumns, 1);
  assert.equal(extracted.template.typography.bodyFont, "Times-Roman");
  assert.ok(extracted.template.visual.regions.some((region) => region.role === "header" && region.color === "#D9E7F3"));
  assert.equal(extracted.template.header.contactRegion, "header");
  assert.ok(extracted.rawExtraction.pages[0]!.text_blocks.some((block) =>
    block.spans.some((span) => span.fontFamily === "Times-Roman" && span.weight === "bold" && span.fillColor === "#17324D"),
  ));
  assert.equal(extracted.template.typography.nameWeight, "bold");

  const finalText = [
    "Marina Nova", "marina.nova@example.test | São Paulo, SP", "RESUMO",
    "Profissional de produto com resultados mensuráveis.", "EXPERIÊNCIA", "Designer — Empresa Exemplo",
  ].join("\n");
  const generated = await renderLayoutTextResumePdf(extracted.template, finalText);
  const geometry = await readPdfTextGeometry(generated);
  const outputName = geometry.find((item) => item.text === "Marina Nova");
  const outputContact = geometry.find((item) => item.text.includes("marina.nova@example.test"));
  const headerRegion = extracted.template.visual.regions.find((region) => region.role === "header")!;
  const sourceName = extracted.rawExtraction.pages[0]!.text_blocks.flatMap((block) => block.spans)
    .find((span) => span.text.includes("Marina Exemplo"))!;
  const sourceContact = extracted.rawExtraction.pages[0]!.text_blocks.find((block) => block.text.includes("marina@example.test"))!.spans[0]!;
  assert.ok(outputName);
  assert.ok(Math.abs(outputName.x - extracted.template.header.nameXPt) < 2);
  assert.ok(Math.abs(outputName.y - sourceName.bbox[1]) < 3);
  assert.ok(outputContact);
  assert.ok(outputContact.x >= headerRegion.x && outputContact.x + outputContact.width <= headerRegion.x + headerRegion.width);
  assert.ok(outputContact.y >= headerRegion.y && outputContact.y + outputContact.height <= headerRegion.y + headerRegion.height);
  assert.ok(Math.abs(outputContact.y - sourceContact.bbox[1]) < 12);
});

test("detects repeated page furniture and preserves stable visual regions in a generated multi-page PDF", async () => {
  const reference = await createMultiPageReferencePdf();
  const extracted = await extractPdfLayout(reference, "two-page-reference.pdf");
  assert.equal(extracted.rawExtraction.pages.length, 2);
  assert.equal(extracted.template.columns.count, 2);
  assert.equal(extracted.template.page.format, "A4");
  assert.ok(extracted.template.columns.sidebarRepeats);
  assert.ok(extracted.template.visual.regions.some((region) => region.role === "sidebar" && region.repeatOnPages));
  assert.equal(extracted.template.header.nameRegion, "sidebar");
  assert.equal((extracted.resumeText.match(/Marina Exemplo/gu) ?? []).length, 1);
  assert.doesNotMatch(extracted.resumeText, /CONTINUAÇÃO/u);
  assert.match(extracted.resumeText, /EXPERIÊNCIA PROFISSIONAL/u);
  assert.match(extracted.resumeText, /Conteúdo de referência da página 2/u);
  assert.equal(extracted.template.visual.sectionPlacements.find((entry) => entry.section === "education")?.region, "main");
  assert.deepEqual(extracted.rawExtraction.extraction_warnings, undefined);
  assert.deepEqual(extracted.rawExtraction.excluded_furniture?.map(({ page_number, text, reason }) => ({ page_number, text, reason })), [
    { page_number: 2, text: "CONTINUAÇÃO", reason: "continuation_label" },
    { page_number: 2, text: "Marina Exemplo", reason: "repeated_name" },
  ]);

  const finalText = [
    "Marina Exemplo", "CONTATO", "marina@example.test", "COMPETÊNCIAS", "TypeScript",
    "EXPERIÊNCIA PROFISSIONAL", "Conteúdo final revisado e aprovado pelo usuário.",
    "PROJETOS E RESULTADOS", "FORMAÇÃO", "Engenharia de Produção — Instituto Novo",
    ...Array.from({ length: 70 }, (_, index) => `Resultado revisado ${index + 1}: entrega documentada, validada e preservada integralmente.`),
    "Segundo bloco integral da versão revisada.",
  ].join("\n");
  const generated = await renderLayoutTextResumePdf(extracted.template, finalText);
  const generatedDocument = await (await import("pdfjs-dist/legacy/build/pdf.mjs")).getDocument({ data: new Uint8Array(generated), isEvalSupported: false }).promise;
  assert.ok(generatedDocument.numPages >= 2);
  await generatedDocument.destroy();
  const referencePage = await rasterizePdfPage(reference);
  const generatedPage = await rasterizePdfPage(generated);
  const referencePageTwo = await rasterizePdfPage(reference, 2);
  const generatedPageTwo = await rasterizePdfPage(generated, 2);
  const generatedGeometry = await readPdfTextGeometry(generated);
  const outputName = generatedGeometry.find((item) => item.text === "Marina Exemplo")!;
  const outputContact = generatedGeometry.find((item) => item.text.includes("marina@example.test"))!;
  const outputExperience = generatedGeometry.find((item) => /EXPERIÊNCIA PROFISSIONAL/iu.test(item.text))!;
  const outputEducation = generatedGeometry.find((item) => /FORMAÇÃO/iu.test(item.text))!;
  const sourceContact = extracted.rawExtraction.pages[0]!.text_blocks.find((block) => block.text.includes("marina@example.test"))!.spans[0]!;
  const sourceName = extracted.rawExtraction.pages[0]!.text_blocks.flatMap((block) => block.spans)
    .find((span) => span.text.includes("Marina Exemplo"))!;
  assert.ok(outputName.x >= extracted.template.columns.sidebarXPt &&
    outputName.x < extracted.template.columns.sidebarXPt + extracted.template.columns.sidebarWidthPt);
  assert.equal(extracted.template.header.nameAlignment, "center");
  assert.ok(Math.abs((outputName.x + outputName.width / 2) - ((sourceName.bbox[0] + sourceName.bbox[2]) / 2)) < 3,
    "center-aligned name should remain centered in the source sidebar");
  assert.ok(outputContact.x >= extracted.template.columns.sidebarXPt &&
    outputContact.x < extracted.template.columns.sidebarXPt + extracted.template.columns.sidebarWidthPt);
  assert.ok(Math.abs(outputContact.y - sourceContact.bbox[1]) < 16);
  assert.ok(outputExperience.x >= extracted.template.columns.mainXPt);
  assert.ok(outputEducation.x >= extracted.template.columns.mainXPt);
  assert.equal(outputEducation.pageNumber, 2);

  // These unprinted interior patches avoid text and antialiased edges: the sidebar and header fills are stable.
  assert.deepEqual(regionPixels(referencePage, 8, 300, 12, 12), regionPixels(generatedPage, 8, 300, 12, 12));
  assert.deepEqual(regionPixels(referencePage, 330, 8, 12, 12), regionPixels(generatedPage, 330, 8, 12, 12));
  assert.deepEqual(regionPixels(referencePageTwo, 8, 300, 12, 12), regionPixels(generatedPageTwo, 8, 300, 12, 12));
});

test("classifies a right-hand sidebar by measured text and region geometry, then renders name, contact, and sections in place", async () => {
  const extracted = await extractPdfLayout(await createRightSidebarResumePdf(), "right-sidebar.pdf");
  const template = extracted.template;
  assert.equal(template.columns.count, 2);
  assert.equal(template.columns.sidebarSide, "right");
  assert.equal(template.header.nameRegion, "sidebar");
  assert.equal(template.header.contactRegion, "sidebar");
  assert.equal(template.visual.sectionPlacements.find((entry) => entry.section === "skills")?.region, "sidebar");
  assert.equal(template.visual.sectionPlacements.find((entry) => entry.section === "experience")?.region, "main");

  const finalText = [
    "Juliana Nova", "CONTATO", "juliana.nova@example.test", "FERRAMENTAS", "SQL", "EXPERIÊNCIA",
    "Analista de Dados — Empresa Nova",
  ].join("\n");
  const generated = await renderLayoutTextResumePdf(template, finalText);
  const geometry = await readPdfTextGeometry(generated);
  const outputName = geometry.find((item) => item.text === "Juliana Nova")!;
  const outputContact = geometry.find((item) => item.text.includes("juliana.nova@example.test"))!;
  const outputSkillHeading = geometry.find((item) => /FERRAMENTAS/iu.test(item.text))!;
  const outputExperienceHeading = geometry.find((item) => /EXPERIÊNCIA/iu.test(item.text))!;
  const sidebarLeft = template.columns.sidebarXPt;
  const sidebarRight = sidebarLeft + template.columns.sidebarWidthPt;
  const sourceContact = extracted.rawExtraction.pages[0]!.text_blocks.find((block) => block.text.includes("juliana@example.test"))!.spans[0]!;
  assert.ok(outputName.x >= sidebarLeft && outputName.x + outputName.width <= sidebarRight);
  assert.ok(Math.abs(outputName.x - template.header.nameXPt) < 3);
  assert.ok(outputContact.x >= sidebarLeft && outputContact.x + outputContact.width <= sidebarRight);
  assert.ok(Math.abs(outputContact.y - sourceContact.bbox[1]) < 16);
  assert.ok(outputSkillHeading.x >= sidebarLeft && outputSkillHeading.x < sidebarRight);
  assert.ok(outputExperienceHeading.x < sidebarLeft);
});

test("preserves ambiguous repeated titles and records extraction uncertainty instead of dropping them", async () => {
  const extracted = await extractPdfLayout(await createAmbiguousRepeatedTitlePdf(), "ambiguous-title.pdf");
  assert.equal((extracted.resumeText.match(/Marina Exemplo/gu) ?? []).length, 1);
  assert.match(extracted.resumeText, /DIRETORA DE ENGENHARIA/u);
  assert.match(extracted.resumeText, /Gerenciei equipes de engenharia/u);
  assert.match(extracted.resumeText, /EXPERIÊNCIA PROFISSIONAL/u);
  assert.ok(extracted.rawExtraction.extraction_warnings?.some((warning) => /parece elemento de apresentação.*foi preservado/iu.test(warning)));
  assert.ok(extracted.layoutWarnings.some((warning) => /não foi possível distingui-lo de conteúdo legítimo/iu.test(warning)));
});

test("retains only the visual template across service restarts and expires it after 24 hours", async () => {
  let now = Date.now();
  const store = new MemoryResumeLayoutStore(() => now);
  const service = new ResumeLayoutService(store, () => now);
  const referencePdf = await createReferencePdf();
  const imported = await service.importPdf(referencePdf, "reference.pdf");
  assert.deepEqual(await service.getTemplate(imported.templateId), imported.template);

  const restartedService = new ResumeLayoutService(store, () => now);
  assert.deepEqual(await restartedService.getTemplate(imported.templateId), imported.template);
  now += 24 * 60 * 60_000 + 1;
  assert.equal(await restartedService.getTemplate(imported.templateId), null);
  assert.equal(await store.deleteExpiredTemporaryResumeLayouts(), 1);
});

test("renders the approved resume text in the extracted visual style with complete pagination", async () => {
  const service = new ResumeLayoutService(new MemoryResumeLayoutStore());
  const imported = await service.importPdf(await createReferencePdf(), "reference.pdf");
  const template = (await service.getTemplate(imported.templateId))!;
  const longSummary = `${"Novo conteúdo profissional com experiência comprovada e resultados mensuráveis. ".repeat(55)}FIM DO RESUMO NOVO`;
  const finalResume = [
    "Pessoa Nova",
    "CONTATO",
    "pessoa@example.test",
    "COMPETÊNCIAS",
    "TypeScript",
    "RESUMO PROFISSIONAL",
    longSummary,
    "EXPERIÊNCIA PROFISSIONAL",
    "Pessoa Desenvolvedora — Empresa Nova",
    "Entrega de APIs com testes automatizados e documentação.",
  ].join("\n");
  const pdf = await renderLayoutTextResumePdf(template, finalResume);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = fileURLToPath(new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));
  const rendered = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl,
  }).promise;
  try {
    assert.ok(rendered.numPages >= 2);
    let generatedText = "";
    for (let pageNumber = 1; pageNumber <= rendered.numPages; pageNumber += 1) {
      const page = await rendered.getPage(pageNumber);
      const content = await page.getTextContent();
      generatedText += `${content.items.map((item) => "str" in item ? item.str : "").join(" ")} `;
    }
    assert.equal(generatedText.replace(/\s+/gu, " ").trim(), finalResume.replace(/\s+/gu, " ").trim());
    assert.doesNotMatch(generatedText, /NOME DA REFERÊNCIA|Experiência com conteúdo de exemplo/);
  } finally {
    await rendered.destroy();
  }

});

test("extracts text and layout in one production API request, then keeps layout only in the analysis session", async (context) => {
  const store = new MemoryResumeLayoutStore();
  let savedTemplate: unknown;
  const repository = Object.assign(store, {
    async isReady() { return true; },
    async createSessionWithTemporaryLayout(_input: unknown, templateId: string) {
      const template = await store.findTemporaryResumeLayout(templateId);
      if (!template) return null;
      savedTemplate = template;
      await store.deleteTemporaryResumeLayout(templateId);
      return { id: "layout-session", createdAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60_000) };
    },
  });
  const makeApp = (service: ResumeLayoutService) => createApp({
    production: true,
    webOrigin: "https://curriculus.example",
    resumeLayoutService: service,
    resumeLayoutImportEnabled: true,
    analysisService: {
      async analyze() {
        return {
          analysis: { jobRequirements: [], suggestions: [], documentStructure: { sectionOrder: [], suggestionOrder: [] } },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: null },
        };
      },
    },
    sessionRepository: repository as never,
  });
  const importApp = makeApp(new ResumeLayoutService(repository));
  let analysisApp: ReturnType<typeof makeApp> | undefined;
  context.after(async () => {
    await importApp.close();
    await analysisApp?.close();
  });

  const referenceBytes = await createReferencePdf();
  const largePdfPayload = Buffer.concat([referenceBytes, Buffer.alloc(700 * 1024, 0x20)]);
  assert.ok(largePdfPayload.length > 640 * 1024);
  const imported = await importApp.inject({
    method: "POST",
    url: "/resume-layouts/import",
    headers: { origin: "https://curriculus.example", "content-type": "application/pdf", "x-file-name": "referencia.pdf" },
    payload: largePdfPayload,
  });
  assert.equal(imported.statusCode, 201);
  const importedBody = imported.json();
  assert.equal("rawExtraction" in importedBody, false);
  assert.equal("template" in importedBody, false);
  assert.equal(importedBody.layoutAvailable, true);
  assert.ok(String(importedBody.resumeText).includes("Experiência com conteúdo de exemplo"));
  await importApp.close();

  // A new service instance models an API restart between upload and analysis.
  const analysisService = new ResumeLayoutService(repository);
  analysisApp = makeApp(analysisService);
  const analyzed = await analysisApp.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobDescription: "Vaga fictícia",
      resume: importedBody.resumeText,
      dataNoticeAcknowledged: true,
      resumeLayoutTemplateId: importedBody.templateId,
    },
  });
  assert.equal(analyzed.statusCode, 201);
  assert.equal(analyzed.json().usesReferenceLayout, true);
  assert.ok(savedTemplate);
  assert.equal((savedTemplate as { id?: string }).id, "adaptive-resume-layout-v1");
  assert.equal(await analysisService.getTemplate(importedBody.templateId), null);

  const deleted = await analysisApp.inject({
    method: "DELETE",
    url: `/resume-layouts/${importedBody.templateId}`,
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal((await analysisApp.inject({ method: "POST", url: "/resumes/render", payload: {} })).statusCode, 404);
});
