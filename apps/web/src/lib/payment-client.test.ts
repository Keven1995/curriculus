import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinalDocument,
  createPixPayment,
  getPixPaymentStatus,
  PaymentClientError,
} from "./payment-client";

test("sends only the payer email to the session Pix endpoint and validates the response", async () => {
  let requestedUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const payment = await createPixPayment(
    "session-test-id",
    " buyer@example.com ",
    {
      apiBaseUrl: "https://api.example.test/",
      fetcher: async (url, init) => {
        requestedUrl = String(url);
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          orderId: "order-test-id",
          amountCents: 199,
          currency: "BRL",
          status: "pending",
          expiresAt: "2026-01-02T00:00:00.000Z",
          qrCode: "pix-copy-code",
          qrCodeBase64: "aGVsbG8=",
        }), { status: 201 });
      },
    },
  );

  assert.equal(requestedUrl, "https://api.example.test/sessions/session-test-id/payments/pix");
  assert.deepEqual(requestBody, { payerEmail: "buyer@example.com" });
  assert.equal(payment.amountCents, 199);
  assert.equal(payment.status, "pending");
  assert.equal(payment.qrCode, "pix-copy-code");
});

test("rejects invalid email locally and maps safe payment service errors", async () => {
  let calls = 0;
  await assert.rejects(
    createPixPayment("session-test-id", "not-an-email", {
      fetcher: async () => {
        calls += 1;
        return new Response();
      },
    }),
    (error: Error) => error instanceof PaymentClientError && error.code === "INVALID_EMAIL",
  );
  assert.equal(calls, 0);

  await assert.rejects(
    createPixPayment("session-test-id", "buyer@example.com", {
      fetcher: async () => new Response(JSON.stringify({ error: { code: "PAYMENT_NOT_CONFIGURED" } }), { status: 503 }),
    }),
    (error: Error) => {
      assert.ok(error instanceof PaymentClientError);
      assert.equal(error.code, "PAYMENT_NOT_CONFIGURED");
      assert.equal(error.message.includes("buyer@example.com"), false);
      return true;
    },
  );
});

test("rejects malformed charge responses without displaying provider details", async () => {
  await assert.rejects(
    createPixPayment("session-test-id", "buyer@example.com", {
      fetcher: async () => new Response(JSON.stringify({
        orderId: "order-test-id",
        amountCents: 1,
        currency: "BRL",
        status: "approved",
        expiresAt: "not-a-date",
        qrCode: "",
        qrCodeBase64: "",
      }), { status: 201 }),
    }),
    (error: Error) => error instanceof PaymentClientError && error.code === "INVALID_RESPONSE",
  );
});

test("checks payment status from the API without trusting browser-provided status", async () => {
  let requestedUrl = "";
  let requestedMethod = "";
  const status = await getPixPaymentStatus("session-test-id", {
    apiBaseUrl: "https://api.example.test/",
    fetcher: async (url, init) => {
      requestedUrl = String(url);
      requestedMethod = String(init?.method);
      return new Response(JSON.stringify({ status: "approved" }), { status: 200 });
    },
  });

  assert.equal(requestedUrl, "https://api.example.test/sessions/session-test-id/payments/status");
  assert.equal(requestedMethod, "GET");
  assert.equal(status, "approved");
});

test("requests a PDF using only approved suggestion IDs and rejects unsafe download URLs", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const document = await createFinalDocument("session-test-id", ["experience-1"], {
    apiBaseUrl: "https://api.example.test",
    fetcher: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        format: "pdf",
        downloadPath: "/documents/session-test-id?token=signed",
        expiresAt: "2026-01-02T00:00:00.000Z",
      }), { status: 201 });
    },
  });

  assert.deepEqual(requestBody, { approvedSuggestionIds: ["experience-1"] });
  assert.equal(document.format, "pdf");

  await assert.rejects(
    createFinalDocument("session-test-id", [], {
      fetcher: async () => new Response(JSON.stringify({
        format: "pdf",
        downloadPath: "https://evil.example/steal",
        expiresAt: "2026-01-02T00:00:00.000Z",
      }), { status: 201 }),
    }),
    (error: Error) => error instanceof PaymentClientError && error.code === "INVALID_RESPONSE",
  );
});
