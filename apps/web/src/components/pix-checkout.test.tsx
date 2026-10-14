import assert from "node:assert/strict";
import test from "node:test";
import "../test/setup-dom.js";
import React from "react";
import axe from "axe-core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PixCheckout } from "./PixCheckout";

const styles = new Proxy<Record<string, string>>({}, {
  get: (_target, property) => String(property),
});

test.afterEach(() => cleanup());

test("has no automated WCAG A/AA accessibility violations in the Pix checkout", async () => {
  const { container } = render(
    <PixCheckout
      sessionId="session-test-id"
      approvedSuggestionIds={[]}
      finalResumeText="Currículo de teste."
      finalResumeAppliedSuggestionIds={[]}
      styles={styles}
      fetcher={async () => new Response()}
    />,
  );

  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });

  assert.deepEqual(
    results.violations.map(({ id, impact }) => ({ id, impact })),
    [],
  );
});

test("local test mode generates a PDF without requesting or displaying a real Pix", async () => {
  const requestedUrls: string[] = [];
  render(
    <PixCheckout
      sessionId="session-test-id"
      localTestMode
      approvedSuggestionIds={["suggestion-test-id"]}
      finalResumeText="Currículo de teste revisado."
      finalResumeAppliedSuggestionIds={["suggestion-test-id"]}
      styles={styles}
      apiBaseUrl="http://127.0.0.1:4000"
      fetcher={async (url) => {
        requestedUrls.push(String(url));
        return new Response(JSON.stringify({
          format: "pdf",
          downloadPath: "/documents/session-test-id?token=temporary-test-token",
          expiresAt: "2026-01-02T00:00:00.000Z",
        }), { status: 201 });
      }}
    />,
  );

  assert.equal(screen.getByRole("heading", { name: "PDF no ambiente de teste" }).textContent, "PDF no ambiente de teste");
  assert.match(screen.getByText(/Nenhum Pix real é criado/).textContent ?? "", /Nenhum Pix real é criado/);
  fireEvent.click(screen.getByRole("button", { name: /Gerar PDF de teste/ }));

  const download = await screen.findByRole("link", { name: "Baixar currículo em PDF" });
  assert.equal(download.getAttribute("href"), "http://127.0.0.1:4000/documents/session-test-id?token=temporary-test-token");
  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:4000/__local-test/sessions/session-test-id/documents",
  ]);
  assert.equal(screen.queryByLabelText(/E-mail para o pagamento Pix/), null);
  assert.equal(screen.queryByRole("img", { name: /QR Code Pix/ }), null);
  await waitFor(() => assert.match(screen.getByRole("status").textContent ?? "", /Nenhum pagamento real foi feito/));
});

test("does not send a PDF request if the editor has not been synchronized with current approvals", () => {
  let calls = 0;
  render(
    <PixCheckout
      sessionId="session-test-id"
      localTestMode
      approvedSuggestionIds={["suggestion-test-id"]}
      finalResumeText="Currículo de teste."
      finalResumeAppliedSuggestionIds={[]}
      styles={styles}
      fetcher={async () => { calls += 1; return new Response(); }}
    />,
  );

  const button = screen.getByRole("button", { name: /Gerar PDF de teste/ }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.match(screen.getByRole("status").textContent ?? "", /aplique novamente as sugestões/i);
  assert.equal(calls, 0);
});
