import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

const jobDescription = "Vaga para pessoa desenvolvedora com experiência em Java.";
const resume = "Trabalhei com Java para construir APIs REST.";

async function createAnalysis(page: Page, request: APIRequestContext): Promise<string> {
  await page.goto("/");
  const analysisResponse = page.waitForResponse((response) =>
    response.url().endsWith("/analyses") && response.request().method() === "POST",
  );
  await page.getByLabel(/Descrição da vaga/).fill(jobDescription);
  const pdfFixture = await request.get("http://127.0.0.1:4174/__e2e/resume-fixture.pdf");
  expect(pdfFixture.status()).toBe(200);
  await page.getByLabel("Anexar currículo em PDF").setInputFiles({
    name: "curriculo-sintetico.pdf",
    mimeType: "application/pdf",
    buffer: await pdfFixture.body(),
  });
  await expect(page.getByLabel("Seu currículo em texto")).toHaveValue(resume);
  await page.getByRole("checkbox", { name: /Li o aviso sobre o uso dos dados/ }).check();
  await page.getByRole("button", { name: /Gerar sugestões/ }).click();

  const response = await analysisResponse;
  expect(response.status()).toBe(201);
  const result = await response.json() as { sessionId: string };
  await expect(page.getByRole("heading", { name: "Revise as sugestões" })).toBeVisible();
  await expect(page.getByText("Desenvolvi APIs REST com Java.")).toBeVisible();
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

test("completes analysis, review, sandbox Pix webhook, private PDF download and retention", async ({ page, request }) => {
  const sessionId = await createAnalysis(page, request);

  await page.getByRole("button", { name: "Aprovar sugestão: Experiência" }).click();
  await expect(page.getByText("Aprovadas: 1 · Rejeitadas: 0 · Pendentes: 0")).toBeVisible();
  await page.getByLabel("E-mail para o pagamento Pix").fill("e2e@example.test");
  await page.getByRole("button", { name: "Gerar código Pix de R$ 1,99" }).click();
  await expect(page.getByRole("heading", { name: "Pix gerado" })).toBeVisible();
  await expect(page.getByLabel("Código Pix copia e cola")).toHaveValue(/.+/);

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

  const inspected = await request.get(`http://127.0.0.1:4174/__e2e/inspect/${sessionId}`);
  expect(inspected.status()).toBe(200);
  expect(await inspected.json()).toMatchObject({
    analysisActive: false,
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
    documentActive: false,
    orderStatus: null,
    payerEmailPersisted: false,
  });
});
