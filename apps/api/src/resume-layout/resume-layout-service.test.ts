import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
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

  assert.equal(extracted.rawExtraction.schema_version, "1.0");
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
  assert.equal(extracted.template.id, "sidebar-dark-header-color-v1");
  assert.equal(extracted.template.palette.sidebar, "#354550");
  assert.equal(extracted.template.palette.headerApprox, "#BACD9E");
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
  assert.equal(extracted.layoutAvailable, true);
  assert.equal(extracted.resumeText.replace(/\s+/gu, " ").trim(), "Trabalhei com Java para construir APIs REST. Tenho experiencia com documentacao tecnica.");
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
  assert.equal((savedTemplate as { id?: string }).id, "sidebar-dark-header-color-v1");
  assert.equal(await analysisService.getTemplate(importedBody.templateId), null);

  const deleted = await analysisApp.inject({
    method: "DELETE",
    url: `/resume-layouts/${importedBody.templateId}`,
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal((await analysisApp.inject({ method: "POST", url: "/resumes/render", payload: {} })).statusCode, 404);
});
