import assert from "node:assert/strict";
import test from "node:test";
import "../test/setup-dom.js";
import React from "react";
import axe from "axe-core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionDataControls } from "./SessionDataControls.js";

const styles = new Proxy<Record<string, string>>({}, {
  get: (_target, property) => String(property),
});

test.afterEach(() => cleanup());

test("asks for explicit confirmation before deleting and clears the local session on success", async () => {
  let requestUrl = "";
  let requestMethod = "";
  let requestBody: BodyInit | null | undefined;
  let cleared = 0;
  render(
    <SessionDataControls
      sessionId="4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea"
      styles={styles}
      apiBaseUrl="https://api.example.test"
      fetcher={async (url, init) => {
        requestUrl = String(url);
        requestMethod = String(init?.method);
        requestBody = init?.body;
        return new Response(null, { status: 204 });
      }}
      onDeleted={() => { cleared += 1; }}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Excluir os dados desta sessão" }));
  assert.equal(cleared, 0);
  assert.ok(screen.getByRole("group", { name: "Confirmar exclusão desta sessão?" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar exclusão" }));

  await waitFor(() => assert.equal(cleared, 1));
  assert.equal(requestUrl, "https://api.example.test/sessions/4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea/data");
  assert.equal(requestMethod, "DELETE");
  assert.equal(requestBody, undefined);
  assert.equal(cleared, 1);
});

test("keeps the session available and offers retry when pending Pix cancellation fails", async () => {
  let calls = 0;
  render(
    <SessionDataControls
      sessionId="4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea"
      styles={styles}
      fetcher={async () => {
        calls += 1;
        return new Response(JSON.stringify({
          error: { code: "PAYMENT_CANCELLATION_UNAVAILABLE", message: "internal detail" },
        }), { status: 503 });
      }}
      onDeleted={() => assert.fail("failed deletion must not clear the local session")}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Excluir os dados desta sessão" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar exclusão" }));
  assert.ok(await screen.findByRole("alert"));
  assert.match(screen.getByRole("alert").textContent ?? "", /não foi possível cancelar/i);
  assert.equal(screen.getByRole("alert").textContent?.includes("internal detail"), false);
  fireEvent.click(screen.getByRole("button", { name: "Confirmar exclusão" }));
  assert.equal(calls, 2);
});

test("has no automated WCAG A/AA violations in the deletion confirmation", async () => {
  const { container } = render(
    <SessionDataControls
      sessionId="4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea"
      styles={styles}
      fetcher={async () => new Response(null, { status: 204 })}
      onDeleted={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Excluir os dados desta sessão" }));

  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  assert.deepEqual(results.violations.map(({ id }) => id), []);
});
