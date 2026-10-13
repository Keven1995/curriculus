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

const apiResponse: AnalysisApiResponse = {
  sessionId: "session-test-id",
  expiresAt: "2026-01-02T00:00:00.000Z",
  analysis: {
    jobRequirements: [],
    suggestions: [
      {
        id: "suggestion-1",
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

function fillValidForm() {
  fireEvent.change(screen.getByLabelText(/Descrição da vaga/), {
    target: { value: "Vaga de pessoa desenvolvedora" },
  });
  fireEvent.change(screen.getByLabelText("Seu currículo em texto"), {
    target: { value: "Currículo de teste" },
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
  assert.equal(screen.getAllByText("Informe o link ou a descrição da vaga.").length, 2);
  assert.equal((screen.getByLabelText("Seu currículo em texto") as HTMLTextAreaElement).value, "");
});

test("does not send a resume when only a job link is provided", () => {
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
  fireEvent.change(screen.getByLabelText(/Link da vaga/), {
    target: { value: "https://example.com/job" },
  });
  fireEvent.change(screen.getByLabelText("Seu currículo em texto"), {
    target: { value: "Currículo sintético" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /gerar sugestões/i }));

  assert.equal(calls, 0);
  assert.equal(screen.getAllByText(/Cole a descrição completa da vaga/).length, 2);
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
  assert.equal(submitted?.resume, "Currículo de teste");
  assert.ok(screen.getByText("Desenvolvi APIs REST."));
  assert.ok(screen.getByText(/o preview, por si só, não inicia uma cobrança/i));

  fireEvent.click(screen.getByRole("button", { name: "Aprovar sugestão: Experiência" }));
  assert.ok(screen.getByText("Aprovada localmente"));
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
  assert.ok(screen.getByText(/não há confirmação automática nem liberação do documento/i));
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

  fireEvent.change(screen.getByLabelText("Seu currículo em texto"), {
    target: { value: "Currículo atualizado" },
  });

  assert.equal(screen.queryByRole("heading", { name: "Revise as sugestões" }), null);
});
