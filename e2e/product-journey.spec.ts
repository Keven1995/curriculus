import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { resolve, sep } from "node:path";

const jobDescription = "Vaga para pessoa desenvolvedora com experiência em Java, construção de APIs REST e liderança de equipes.";
const resume = "Trabalhei com Java para construir APIs REST. Tenho experiencia com documentacao\ntecnica.";

async function createAnalysis(page: Page, request: APIRequestContext): Promise<string> {
  await page.goto("/");
  const analysisResponse = page.waitForResponse((response) =>
    response.url().endsWith("/analyses") && response.request().method() === "POST",
  );
  await page.getByLabel(/Descrição da vaga/).fill(jobDescription);
  const pdfFixture = await request.get("http://127.0.0.1:4174/__e2e/resume-fixture.pdf");
  expect(pdfFixture.status()).toBe(200);
  const layoutImport = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/resume-layouts/import"),
  );
  await page.getByLabel(/Seu currículo em PDF/).setInputFiles({
    name: "curriculo-sintetico.pdf",
    mimeType: "application/pdf",
    buffer: await pdfFixture.body(),
  });
  await page.getByRole("checkbox", { name: /Li o aviso/ }).check();
  await page.getByRole("button", { name: /Gerar sugestões/ }).click();

  const importResponse = await layoutImport;
  expect(importResponse.status()).toBe(201);
  expect(importResponse.headers()["access-control-allow-origin"]).toBe("http://127.0.0.1:4173");
  const importBody = await importResponse.json() as { resumeText: string; layoutAvailable: boolean; templateId?: string };
  expect(importBody.layoutAvailable).toBe(true);
  expect(importBody.templateId).toEqual(expect.any(String));
  expect(importBody.resumeText.replace(/\s+/gu, " ").trim()).toBe(resume.replace(/\s+/gu, " ").trim());

  const response = await analysisResponse;
  expect(response.status()).toBe(201);
  const result = await response.json() as { sessionId: string };
  await expect(page.getByRole("heading", { name: "Revise as sugestões" })).toBeVisible();
  await expect(page.getByLabel(/Texto extraído do currículo/)).toHaveValue(/Trabalhei com Java/);
  await expect(page.getByText("Desenvolvi APIs REST com Java.")).toBeVisible();
  await expect(page.getByText("experiência com documentação técnica")).toBeVisible();
  return result.sessionId;
}

test("presents the new landing page and its clear path to the analysis form", async ({ page }) => {
  const hydrationIssues: string[] = [];
  page.on("console", (message) => {
    if (/hydrated|server rendered HTML|nativeButton|native button semantics/i.test(message.text())) {
      hydrationIssues.push(message.text());
    }
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: /Um currículo mais alinhado à vaga/ })).toBeVisible();
  await expect(page.getByText("EXEMPLO DE REVISÃO")).toBeVisible();
  await expect(page.getByText("R$ 1,99")).toBeVisible();
  const wordMargins = await page.locator("#page-title .heroAccent > span > span").evaluateAll((words) =>
    words.map((word) => Number.parseFloat(getComputedStyle(word).marginRight)),
  );
  expect(wordMargins.slice(0, -1).every((margin) => margin > 0)).toBe(true);
  await page.waitForTimeout(1_100);
  expect(hydrationIssues).toEqual([]);

  await page.getByRole("link", { name: /Começar minha análise/ }).click();
  await expect(page.getByLabel(/Descrição da vaga/)).toBeInViewport();
});

test("completes browser CORS PDF upload, edited final text, sandbox payment, private download and retention", async ({ page, request }) => {
  const sessionId = await createAnalysis(page, request);
  const reviewState = await request.get(`http://127.0.0.1:4174/__e2e/inspect/${sessionId}`);
  expect(await reviewState.json()).toMatchObject({ analysisActive: true, layoutAttached: true });

  await page.getByRole("button", { name: "Aprovar sugestão: Experiência" }).click();
  await page.getByRole("button", { name: "Aprovar correção ortográfica: Ortografia e pontuação" }).click();
  await expect(page.getByText("Aprovadas: 2 · Rejeitadas: 0 · Pendentes: 0")).toBeVisible();
  await page.getByRole("button", { name: "Aplicar sugestões aprovadas (2)" }).click();
  const finalResumeEditor = page.getByLabel("Currículo final editável");
  const confirmedFinalText = `${await finalResumeEditor.inputValue()}\nAjuste exclusivo da pessoa usuária.`;
  await finalResumeEditor.fill(confirmedFinalText);
  await page.getByLabel("E-mail para o pagamento Pix").fill("e2e@example.test");
  await page.getByRole("button", { name: "Gerar código Pix de R$ 1,99" }).click();
  await expect(page.getByRole("heading", { name: "Pix gerado" })).toBeVisible();
  await expect(page.getByLabel("Código Pix copia e cola")).toHaveValue(/.+/);
  const duringPayment = await request.get(`http://127.0.0.1:4174/__e2e/inspect/${sessionId}`);
  expect(await duringPayment.json()).toMatchObject({ analysisActive: true, layoutAttached: true });

  const approval = await request.post("http://127.0.0.1:4174/__e2e/approve", {
    data: { sessionId },
  });
  expect(approval.status()).toBe(200);

  await page.getByRole("button", { name: "Verificar pagamento" }).click();
  await expect(page.getByText("Pagamento confirmado. Você já pode gerar seu currículo final em PDF.")).toBeVisible();
  await page.getByRole("button", { name: "Gerar currículo final em PDF" }).click();
  const downloadLink = page.getByRole("link", { name: "Baixar currículo em PDF" });
  await expect(downloadLink).toBeVisible();

  const downloadStarted = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("curriculo.pdf");
  const pdfPath = await download.path();
  expect(pdfPath).not.toBeNull();
  const { readFile } = await import("node:fs/promises");
  const pdf = await readFile(pdfPath!);
  expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = `${resolve(process.cwd(), "node_modules/pdfjs-dist/standard_fonts")}${sep}`;
  const parsed = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, useSystemFonts: true, standardFontDataUrl }).promise;
  try {
    let finalPdfText = "";
    for (let pageNumber = 1; pageNumber <= parsed.numPages; pageNumber += 1) {
      const page = await parsed.getPage(pageNumber);
      const content = await page.getTextContent();
      finalPdfText += `${content.items.map((item) => "str" in item ? item.str : "").join(" ")} `;
    }
    expect(finalPdfText.replace(/\s+/gu, " ").trim()).toBe(confirmedFinalText.replace(/\s+/gu, " ").trim());
  } finally {
    await parsed.destroy();
  }

  const inspected = await request.get(`http://127.0.0.1:4174/__e2e/inspect/${sessionId}`);
  expect(inspected.status()).toBe(200);
  expect(await inspected.json()).toMatchObject({
    analysisActive: false,
    layoutAttached: false,
    documentActive: true,
    orderStatus: "approved",
    payerEmailSentToProvider: true,
    payerEmailPersisted: false,
  });
});

test("deletes a temporary analysis session from the browser and keeps no source data", async ({ page, request }) => {
  const sessionId = await createAnalysis(page, request);

  await page.getByRole("button", { name: "Excluir os dados desta sessão" }).click();
  await expect(page.getByRole("heading", { name: "Confirmar exclusão desta sessão?" })).toBeVisible();
  await page.getByRole("button", { name: "Confirmar exclusão" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Os dados desta sessão foram removidos." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Revise as sugestões" })).toHaveCount(0);

  const inspected = await request.get(`http://127.0.0.1:4174/__e2e/inspect/${sessionId}`);
  expect(inspected.status()).toBe(200);
  expect(await inspected.json()).toMatchObject({
    analysisActive: false,
    layoutAttached: false,
    documentActive: false,
    orderStatus: null,
    payerEmailPersisted: false,
  });
});
