import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderResumePdf } from "./pdf-renderer.js";

async function inspectPdf(pdf: Buffer): Promise<{
  pages: Array<{ width: number; height: number }>;
  textItems: Array<{ page: number; text: string; x: number; y: number; width: number; height: number; fontSize: number }>;
}> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = fileURLToPath(new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;
  const pages: Array<{ width: number; height: number }> = [];
  const textItems: Array<{ page: number; text: string; x: number; y: number; width: number; height: number; fontSize: number }> = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ width: viewport.width, height: viewport.height });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        textItems.push({
          page: pageNumber,
          text: item.str,
          x: item.transform[4]!,
          y: viewport.height - item.transform[5]! - item.height,
          width: item.width,
          height: item.height,
          fontSize: Math.hypot(item.transform[0]!, item.transform[1]!),
        });
      }
    }
    return { pages, textItems };
  } finally {
    await document.destroy();
  }
}

test("renders a valid PDF with selectable text and without adding model-generated content", async () => {
  const resume = "Desenvolvi APIs em Java.\nExperiência com SQL.";
  const pdf = await renderResumePdf(resume);

  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(pdf.length > 1_000);
  assert.equal(pdf.subarray(-6).toString("ascii"), "%%EOF\n");

  const inspected = await inspectPdf(pdf);
  const extractedText = inspected.textItems.map(({ text }) => text).join(" ").replace(/\s+/gu, " ");
  assert.match(extractedText, /Desenvolvi APIs em Java\./u);
  assert.match(extractedText, /Experiência com SQL\./u);
  assert.ok(inspected.pages.length >= 1);
});

test("keeps long fallback PDFs paginated, readable, in bounds, and free of overlapping text", async () => {
  const resume = [
    "Marina Costa",
    "marina@example.test | São Paulo, SP | linkedin.example/marina",
    "RESUMO",
    "Profissional com experiência em dados e produtos digitais.",
    ...Array.from({ length: 150 }, (_, index) =>
      `Experiência ${index + 1}: análise de dados, documentação técnica e colaboração com equipes de produto.`,
    ),
    "FIM DO CURRÍCULO",
  ].join("\n");
  const inspected = await inspectPdf(await renderResumePdf(resume));
  const extractedText = inspected.textItems.map(({ text }) => text).join(" ").replace(/\s+/gu, " ");

  assert.ok(inspected.pages.length > 1, "long content must continue onto additional pages");
  assert.equal(extractedText.trim(), resume.replace(/\s+/gu, " ").trim());
  assert.ok(inspected.textItems.length > 150);

  for (const item of inspected.textItems) {
    const page = inspected.pages[item.page - 1]!;
    assert.ok(item.fontSize >= 10, `font below 10pt: ${item.text}`);
    assert.ok(item.x >= 55, `text crosses the left margin: ${item.text}`);
    assert.ok(item.x + item.width <= page.width - 54, `text crosses the right margin: ${item.text}`);
    assert.ok(item.y >= 40, `text crosses the top margin: ${item.text} at ${item.y.toFixed(1)}pt`);
    assert.ok(item.y + item.height <= page.height - 53, `text crosses the bottom margin: ${item.text}`);
  }

  for (let leftIndex = 0; leftIndex < inspected.textItems.length; leftIndex += 1) {
    const left = inspected.textItems[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < inspected.textItems.length; rightIndex += 1) {
      const right = inspected.textItems[rightIndex]!;
      if (left.page !== right.page) continue;
      const horizontalOverlap = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
      const verticalOverlap = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
      assert.ok(!(horizontalOverlap > 1 && verticalOverlap > 1), `overlapping text: ${left.text} / ${right.text}`);
    }
  }
});
