import assert from "node:assert/strict";
import test from "node:test";
import "../test/setup-dom.js";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AnalysisFlow } from "./AnalysisFlow";
import type { AnalysisApiResponse } from "../lib/analysis-client";

const styles = new Proxy<Record<string, string>>({}, {
  get: (_target, property) => String(property),
});
const validPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]);

const apiResponse: AnalysisApiResponse = {
  sessionId: "session-test-id",
  expiresAt: "2026-01-02T00:00:00.000Z",
  analysis: {
    jobRequirements: [],
    suggestions: [
      {
        id: "suggestion-1",
        category: "job_alignment",
        section: "Experiência",
        originalText: "Desenvolvi APIs.",
        suggestedText: "Desenvolvi APIs REST.",
        relatedRequirementIds: [],
        rationale: "Explicita o tipo de API descrito.",
        sourceFacts: ["Desenvolvi APIs."],
        pointsToConfirm: [],
        sourceRange: { start: 0, end: 16 },
      },
    ],
    documentStructure: {
      sectionOrder: ["Experiência"],
      suggestionOrder: ["suggestion-1"],
    },
  },
  usage: {
    inputTokens: 123,
    outputTokens: 456,
    totalTokens: 579,
    estimatedCostUsd: null,
  },
};

test.afterEach(() => cleanup());

test("uploads a selected PDF to the API once and submits extracted text with an opaque layout handle", async () => {
  let submitted: Record<string, unknown> | undefined;
  let uploads = 0;
  render(
    <AnalysisFlow
      styles={styles}
      apiBaseUrl="https://api.example.test"
      fetcher={async (url, init) => {
        if (String(url).endsWith("/resume-layouts/import")) {
          uploads += 1;
          assert.equal(init?.method, "POST");
          return new Response(JSON.stringify({
            templateId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
            resumeText: "Texto extraído pela API.",
            layoutAvailable: true,
            expiresAt: "2026-01-02T00:00:00.000Z",
          }), { status: 201 });
        }
        submitted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(apiResponse), { status: 201 });
      }}
    />,
  );

  fireEvent.change(screen.getByLabelText(/Descrição da vaga/), {
    target: { value: "Vaga para pessoa desenvolvedora" },
  });
  fireEvent.change(screen.getByLabelText(/Seu currículo em PDF/), {
    target: { files: [new File([validPdfBytes], "curriculo.pdf", { type: "application/pdf" })] },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByRole("heading", { name: "Revise as sugestões" });

  assert.equal(uploads, 1);
  assert.equal(submitted?.resume, "Texto extraído pela API.");
  assert.equal(submitted?.resumeLayoutTemplateId, "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea");
  assert.equal("file" in (submitted ?? {}), false);
});

test("clearly falls back to a simple visual style when extracted text has no reproducible layout", async () => {
  let submitted: Record<string, unknown> | undefined;
  render(
    <AnalysisFlow
      styles={styles}
      fetcher={async (url, init) => {
        if (String(url).endsWith("/resume-layouts/import")) {
          return new Response(JSON.stringify({
            resumeText: "Currículo extraído sem layout compatível.",
            layoutAvailable: false,
            expiresAt: "2026-01-02T00:00:00.000Z",
          }), { status: 201 });
        }
        submitted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(apiResponse), { status: 201 });
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Descrição da vaga/), { target: { value: "Vaga" } });
  fireEvent.change(screen.getByLabelText(/Seu currículo em PDF/), {
    target: { files: [new File([validPdfBytes], "curriculo.pdf", { type: "application/pdf" })] },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));

  await screen.findByRole("heading", { name: "Revise as sugestões" });
  assert.ok(screen.getByText(/não foi possível reaplicar o estilo visual.*formato simples/i));
  assert.equal(submitted?.resume, "Currículo extraído sem layout compatível.");
  assert.equal("resumeLayoutTemplateId" in (submitted ?? {}), false);
  assert.equal(screen.queryByText(/template|JSON|sidebar-dark-header-color/i), null);
});

test("carries an uploaded reference layout through AI review to the existing approved-PDF download flow", async () => {
  const submittedAnalysis: Record<string, unknown>[] = [];
  let documentRequest: Record<string, unknown> | undefined;
  const importedLayout = {
    templateId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
    resumeText: "Desenvolvi APIs.",
    layoutAvailable: true,
    expiresAt: "2026-01-02T00:00:00.000Z",
  };
  const fetcher: typeof fetch = async (url, init) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/resume-layouts/import")) return new Response(JSON.stringify(importedLayout), { status: 201 });
    if (requestUrl.endsWith("/analyses")) {
      submittedAnalysis.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ...apiResponse, localTestMode: true, usesReferenceLayout: true }), { status: 201 });
    }
    assert.equal(requestUrl, "https://api.example.test/__local-test/sessions/session-test-id/documents");
    documentRequest = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      format: "pdf",
      downloadPath: "/documents/session-test-id?token=local-capability",
      expiresAt: "2026-01-02T00:00:00.000Z",
      layoutFallback: false,
    }), { status: 201 });
  };

  render(
    <AnalysisFlow
      styles={styles}
      apiBaseUrl="https://api.example.test"
      fetcher={fetcher}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Descrição da vaga/), { target: { value: "Vaga de pessoa desenvolvedora" } });
  fireEvent.change(screen.getByLabelText(/Seu currículo em PDF/), {
    target: { files: [new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1])], "referencia.pdf", { type: "application/pdf" })] },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByText("Extraímos o currículo. O PDF final tentará preservar o estilo visual original.");
  await screen.findByRole("heading", { name: "Revise as sugestões" });

  assert.equal(submittedAnalysis.length, 1);
  assert.equal(submittedAnalysis[0]?.resumeLayoutTemplateId, importedLayout.templateId);
  assert.equal(submittedAnalysis[0]?.resume, "Desenvolvi APIs.");
  assert.equal(screen.queryByText(/schemaVersion|sidebar-dark-header-color|#354550|confidence/i), null);
  fireEvent.click(screen.getByRole("button", { name: "Aprovar sugestão: Experiência" }));
  fireEvent.click(screen.getByRole("button", { name: "Aplicar sugestões aprovadas (1)" }));
  fireEvent.change(screen.getByLabelText("Currículo final editável"), {
    target: { value: "Currículo final com ajuste manual." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Gerar PDF de teste (sem cobrança)" }));

  const download = await screen.findByRole("link", { name: "Baixar currículo em PDF" });
  assert.deepEqual(documentRequest, {
    approvedSuggestionIds: ["suggestion-1"],
    finalResumeText: "Currículo final com ajuste manual.",
  });
  assert.equal(download.getAttribute("href"), "https://api.example.test/documents/session-test-id?token=local-capability");
  assert.ok(screen.getByText(/PDF usará o layout extraído do PDF/i));
});

test("keeps manual text available as a fallback when the API cannot extract a selected PDF", async () => {
  let uploadCalls = 0;
  render(
    <AnalysisFlow
      styles={styles}
      fetcher={async (url) => {
        if (String(url).endsWith("/resume-layouts/import")) {
          uploadCalls += 1;
          throw new Error("sensitive parser output");
        }
        return new Response(JSON.stringify(apiResponse), { status: 201 });
      }}
    />,
  );

  fireEvent.change(screen.getByLabelText(/Descrição da vaga/), { target: { value: "Vaga" } });
  const resumeField = screen.getByLabelText(/Ou cole o currículo em texto/) as HTMLTextAreaElement;
  fireEvent.change(resumeField, { target: { value: "Texto escrito manualmente." } });
  fireEvent.change(screen.getByLabelText(/Seu currículo em PDF/), {
    target: { files: [new File([validPdfBytes], "curriculo.pdf", { type: "application/pdf" })] },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));

  assert.ok(await screen.findByText(/Não foi possível processar o PDF agora/));
  assert.match(screen.getByRole("alert").textContent ?? "", /PDF|currículo/i);
  assert.equal(screen.queryByText(/sensitive parser output/), null);
  assert.equal(resumeField.value, "Texto escrito manualmente.");
  assert.equal(uploadCalls, 1);
  fireEvent.click(screen.getByRole("button", { name: "Continuar com o currículo colado" }));
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByRole("heading", { name: "Revise as sugestões" });
  assert.equal(uploadCalls, 1);
});

test("retains extracted text and layout after a temporary analysis failure without uploading the PDF again", async () => {
  let uploadCalls = 0;
  let analysisCalls = 0;
  render(
    <AnalysisFlow
      styles={styles}
      apiBaseUrl="https://api.example.test"
      fetcher={async (url, init) => {
        if (String(url).endsWith("/resume-layouts/import")) {
          uploadCalls += 1;
          return new Response(JSON.stringify({
            templateId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
            resumeText: "Texto recuperado do PDF.",
            layoutAvailable: true,
            expiresAt: "2026-01-02T00:00:00.000Z",
          }), { status: 201 });
        }
        analysisCalls += 1;
        if (analysisCalls === 1) {
          return new Response(JSON.stringify({ error: { code: "ANALYSIS_PROVIDER_ERROR" } }), { status: 503 });
        }
        assert.equal(JSON.parse(String(init?.body)).resume, "Texto recuperado do PDF.");
        return new Response(JSON.stringify(apiResponse), { status: 201 });
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Descrição da vaga/), { target: { value: "Vaga" } });
  fireEvent.change(screen.getByLabelText(/Seu currículo em PDF/), {
    target: { files: [new File([validPdfBytes], "curriculo.pdf", { type: "application/pdf" })] },
  });
  fireEvent.click(screen.getByRole("checkbox"));

  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByText("Não foi possível concluir a análise. Tente novamente mais tarde.");
  assert.equal((screen.getByLabelText(/Texto extraído do currículo/) as HTMLTextAreaElement).value, "Texto recuperado do PDF.");
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByRole("heading", { name: "Revise as sugestões" });

  assert.equal(uploadCalls, 1);
  assert.equal(analysisCalls, 2);
});

function fillValidForm() {
  fireEvent.change(screen.getByLabelText(/Descrição da vaga/), {
    target: { value: "Vaga de pessoa desenvolvedora" },
  });
  fireEvent.change(screen.getByLabelText(/Ou cole o currículo em texto/), {
    target: { value: "Desenvolvi APIs." },
  });
  fireEvent.click(screen.getByRole("checkbox"));
}

test("validates locally before sending and keeps entered text on errors", () => {
  let calls = 0;
  render(
    <AnalysisFlow
      styles={styles}
      apiBaseUrl="https://api.example.test"
      fetcher={async () => {
        calls += 1;
        throw new Error("should not call");
      }}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));

  assert.equal(calls, 0);
  assert.equal(screen.getByText("Cole a descrição completa da vaga.").textContent, "Cole a descrição completa da vaga.");
  assert.equal((screen.getByLabelText(/Ou cole o currículo em texto/) as HTMLTextAreaElement).value, "");
});

test("requires pasted job text and no longer presents a link field", () => {
  let calls = 0;
  render(
    <AnalysisFlow
      styles={styles}
      fetcher={async () => {
        calls += 1;
        throw new Error("should not send personal content");
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Ou cole o currículo em texto/), {
    target: { value: "Currículo sintético" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  assert.equal(screen.queryByLabelText(/Link da vaga/), null);
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));

  assert.equal(calls, 0);
  assert.equal(screen.getByText("Cole a descrição completa da vaga.").textContent, "Cole a descrição completa da vaga.");
});

test("submits once, displays the accessible preview, and keeps decisions local", async () => {
  let calls = 0;
  let submitted: Record<string, unknown> | undefined;
  render(
    <AnalysisFlow
      styles={styles}
      apiBaseUrl="https://api.example.test"
      fetcher={async (url, init) => {
        calls += 1;
        assert.equal(url, "https://api.example.test/analyses");
        submitted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(apiResponse), { status: 201 });
      }}
    />,
  );

  fillValidForm();
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));

  await screen.findByRole("heading", { name: "Revise as sugestões" });
  assert.equal(document.activeElement, screen.getByRole("heading", { name: "Revise as sugestões" }));
  assert.equal(calls, 1);
  assert.equal(submitted?.resume, "Desenvolvi APIs.");
  assert.ok(screen.getByText("Desenvolvi APIs REST."));
  assert.ok(screen.getByText(/baixar uma versão em texto na etapa seguinte, sem cobrança/i));

  fireEvent.click(screen.getByRole("button", { name: "Aprovar sugestão: Experiência" }));
  assert.ok(screen.getByText("Aprovada localmente"));
  fireEvent.click(screen.getByRole("button", { name: /Aplicar sugestões aprovadas \(1\)/ }));
  assert.equal((screen.getByLabelText("Currículo final editável") as HTMLTextAreaElement).value, "Desenvolvi APIs REST.");
  assert.equal(calls, 1);
});

test("creates a Pix charge only after the explicit checkout submission", async () => {
  let analysisCalls = 0;
  let paymentCalls = 0;
  let paymentBody: Record<string, unknown> | undefined;
  render(
    <AnalysisFlow
      styles={styles}
      apiBaseUrl="https://api.example.test"
      fetcher={async (url, init) => {
        if (String(url).endsWith("/analyses")) {
          analysisCalls += 1;
          return new Response(JSON.stringify(apiResponse), { status: 201 });
        }
        paymentCalls += 1;
        assert.equal(String(url), "https://api.example.test/sessions/session-test-id/payments/pix");
        paymentBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          orderId: "order-test-id",
          amountCents: 199,
          currency: "BRL",
          status: "pending",
          expiresAt: "2026-01-02T00:00:00.000Z",
          qrCode: "pix-copy-code",
          qrCodeBase64: "aGVsbG8=",
        }), { status: 201 });
      }}
    />,
  );

  fillValidForm();
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByRole("heading", { name: "Revise as sugestões" });

  assert.equal(paymentCalls, 0);
  assert.ok(screen.getByText("R$ 1,99", { exact: true }));
  fireEvent.change(screen.getByLabelText("E-mail para o pagamento Pix"), {
    target: { value: "buyer@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: /gerar código pix de r\$ 1,99/i }));

  await screen.findByRole("heading", { name: "Pix gerado" });
  assert.equal(document.activeElement, screen.getByRole("heading", { name: "Pix gerado" }));
  assert.equal(analysisCalls, 1);
  assert.equal(paymentCalls, 1);
  assert.deepEqual(paymentBody, { payerEmail: "buyer@example.com" });
  assert.ok(screen.getByRole("img", { name: /qr code pix de r\$ 1,99/i }));
  assert.ok(screen.getByDisplayValue("pix-copy-code"));
  assert.ok(screen.getByText(/pagamentos públicos seguem desativados até a validação operacional/i));
});

test("only offers the final PDF after server confirmation and sends approved IDs with edited text", async () => {
  let documentRequest: Record<string, unknown> | undefined;
  render(
    <AnalysisFlow
      styles={styles}
      apiBaseUrl="https://api.example.test"
      fetcher={async (url, init) => {
        const requestUrl = String(url);
        if (requestUrl.endsWith("/analyses")) {
          return new Response(JSON.stringify(apiResponse), { status: 201 });
        }
        if (requestUrl.endsWith("/payments/pix")) {
          return new Response(JSON.stringify({
            orderId: "order-test-id",
            amountCents: 199,
            currency: "BRL",
            status: "pending",
            expiresAt: "2026-01-02T00:00:00.000Z",
            qrCode: "pix-copy-code",
            qrCodeBase64: "aGVsbG8=",
          }), { status: 201 });
        }
        if (requestUrl.endsWith("/payments/status")) {
          return new Response(JSON.stringify({ status: "approved" }), { status: 200 });
        }
        assert.equal(requestUrl, "https://api.example.test/sessions/session-test-id/documents");
        documentRequest = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          format: "pdf",
          downloadPath: "/documents/session-test-id?token=signed-capability",
          expiresAt: "2026-01-02T00:00:00.000Z",
        }), { status: 201 });
      }}
    />,
  );

  fillValidForm();
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByRole("heading", { name: "Revise as sugestões" });
  fireEvent.click(screen.getByRole("button", { name: "Aprovar sugestão: Experiência" }));
  fireEvent.click(screen.getByRole("button", { name: "Aplicar sugestões aprovadas (1)" }));
  fireEvent.change(screen.getByLabelText("Currículo final editável"), {
    target: { value: "Currículo alterado manualmente antes do pagamento." },
  });
  fireEvent.change(screen.getByLabelText("E-mail para o pagamento Pix"), {
    target: { value: "buyer@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: /gerar código pix de r\$ 1,99/i }));
  await screen.findByRole("heading", { name: "Pix gerado" });

  assert.equal(screen.queryByRole("button", { name: /gerar currículo final em pdf/i }), null);
  fireEvent.click(screen.getByRole("button", { name: "Verificar pagamento" }));
  fireEvent.click(await screen.findByRole("button", { name: "Gerar currículo final em PDF" }));

  const download = await screen.findByRole("link", { name: "Baixar currículo em PDF" });
  assert.deepEqual(documentRequest, {
    approvedSuggestionIds: ["suggestion-1"],
    finalResumeText: "Currículo alterado manualmente antes do pagamento.",
  });
  assert.equal(download.getAttribute("href"), "https://api.example.test/documents/session-test-id?token=signed-capability");
  assert.ok(screen.getByText(/sem nova chamada à IA/i));
});

test("marks an invalid checkout email and does not request a Pix charge", async () => {
  let paymentCalls = 0;
  render(
    <AnalysisFlow
      styles={styles}
      fetcher={async (url) => {
        if (String(url).endsWith("/analyses")) {
          return new Response(JSON.stringify(apiResponse), { status: 201 });
        }
        paymentCalls += 1;
        return new Response();
      }}
    />,
  );

  fillValidForm();
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByRole("heading", { name: "Revise as sugestões" });
  fireEvent.click(screen.getByRole("button", { name: /gerar código pix de r\$ 1,99/i }));

  assert.equal(paymentCalls, 0);
  await screen.findByRole("alert");
  assert.equal(screen.getByLabelText("E-mail para o pagamento Pix").getAttribute("aria-invalid"), "true");
  assert.ok(screen.getByRole("alert").textContent?.includes("Informe um e-mail válido"));
});

test("shows safe errors from the API without presenting a false preview", async () => {
  render(
    <AnalysisFlow
      styles={styles}
      fetcher={async () =>
        new Response(
          JSON.stringify({ error: { code: "JOB_DESCRIPTION_REQUIRED", message: "secret" } }),
          { status: 422 },
        )}
    />,
  );
  fillValidForm();
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));

  await waitFor(() => {
    assert.ok(screen.getByRole("alert").textContent?.includes("Cole a descrição completa da vaga"));
  });
  assert.equal(screen.queryByRole("heading", { name: "Revise as sugestões" }), null);
  assert.equal(screen.getByRole("alert").textContent?.includes("secret"), false);
});

test("clears a previous preview when the source text changes", async () => {
  render(
    <AnalysisFlow
      styles={styles}
      fetcher={async () => new Response(JSON.stringify(apiResponse), { status: 201 })}
    />,
  );
  fillValidForm();
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));
  await screen.findByRole("heading", { name: "Revise as sugestões" });

  fireEvent.change(screen.getByLabelText(/Ou cole o currículo em texto/), {
    target: { value: "Currículo atualizado" },
  });

  assert.equal(screen.queryByRole("heading", { name: "Revise as sugestões" }), null);
});
