import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import test from "node:test";
import { createApp } from "../app.js";
import { extractPdfLayout } from "./pdf-layout-extractor.js";
import { ResumeLayoutError } from "./resume-layout-errors.js";
import { ResumeLayoutService } from "./resume-layout-service.js";
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

test("caches only a reusable visual template briefly after extracting the reference", async () => {
  let now = Date.now();
  const service = new ResumeLayoutService(() => now);
  const referencePdf = await createReferencePdf();
  const imported = await service.importPdf(referencePdf, "reference.pdf");
  const cached = await service.importPdf(referencePdf, "renamed-reference.pdf");
  assert.equal(cached.templateId, imported.templateId);
  assert.deepEqual(service.getTemplate(imported.templateId), imported.template);
  assert.equal(service.deleteTemplate(imported.templateId), true);
  assert.equal(service.getTemplate(imported.templateId), undefined);
  const afterDelete = await service.importPdf(referencePdf, "reference.pdf");
  now += 31 * 60_000;
  assert.equal(service.getTemplate(afterDelete.templateId), undefined);
});

test("renders the approved resume text in the extracted visual style with complete pagination", async () => {
  const service = new ResumeLayoutService();
  const imported = await service.importPdf(await createReferencePdf(), "reference.pdf");
  const template = service.getTemplate(imported.templateId)!;
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
    standardFontDataUrl,
  }).promise;
  try {
    assert.ok(rendered.numPages >= 2);
    let generatedText = "";
    for (let pageNumber = 1; pageNumber <= rendered.numPages; pageNumber += 1) {
      const page = await rendered.getPage(pageNumber);
      const content = await page.getTextContent();
      generatedText += content.items.map((item) => "str" in item ? item.str : "").join(" ");
    }
    assert.match(generatedText, /PESSOA NOVA/);
    assert.match(generatedText, /FIM DO\s+RESUMO NOVO/);
    assert.match(generatedText, /Empresa Nova/);
    assert.match(generatedText, /pessoa@example\.test/);
    assert.doesNotMatch(generatedText, /NOME DA REFERÊNCIA|Experiência com conteúdo de exemplo/);
  } finally {
    await rendered.destroy();
  }

});

test("integrates PDF import with the existing analysis session instead of a separate renderer route", async (context) => {
  const service = new ResumeLayoutService();
  let savedTemplate: unknown;
  const app = createApp({
    localTestMode: true,
    resumeLayoutService: service,
    analysisService: {
      async analyze() {
        return {
          analysis: { jobRequirements: [], suggestions: [], documentStructure: { sectionOrder: [], suggestionOrder: [] } },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: null },
        };
      },
    },
    sessionRepository: {
      async isReady() { return true; },
      async createSession(input) {
        savedTemplate = input.resumeLayoutTemplate;
        return { id: "layout-session", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
      },
    } as never,
  });
  context.after(() => app.close());

  const imported = await app.inject({
    method: "POST",
    url: "/resume-layouts/import",
    headers: { "content-type": "application/pdf", "x-file-name": "referencia.pdf" },
    payload: await createReferencePdf(),
  });
  assert.equal(imported.statusCode, 201);
  const importedBody = imported.json();
  assert.equal("rawExtraction" in importedBody, false);
  const analyzed = await app.inject({
    method: "POST",
    url: "/analyses",
    payload: {
      jobDescription: "Vaga fictícia",
      resume: "Texto fictício novo",
      dataNoticeAcknowledged: true,
      resumeLayoutTemplateId: importedBody.templateId,
    },
  });
  assert.equal(analyzed.statusCode, 201);
  assert.equal(analyzed.json().usesReferenceLayout, true);
  assert.deepEqual(savedTemplate, importedBody.template);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/resume-layouts/${importedBody.templateId}`,
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal((await app.inject({ method: "POST", url: "/resumes/render", payload: {} })).statusCode, 404);
});
