import assert from "node:assert/strict";
import test from "node:test";
import { MercadoPagoPixPaymentProvider } from "./mercadopago-pix-provider.js";
import { PixPaymentProviderError } from "./payment-errors.js";

const chargeInput = {
  orderId: "7fcf1fc0-23fc-45c4-a088-79e7bd09f293",
  amountCents: 199 as const,
  currency: "BRL" as const,
  payerEmail: "buyer@example.com",
  idempotencyKey: "7fcf1fc0-23fc-45c4-a088-79e7bd09f293",
  expiresAt: new Date("2026-01-01T12:00:00.000Z"),
};

function pendingResponse() {
  return {
    id: 987654321,
    status: "pending",
    status_detail: "pending_waiting_transfer",
    transaction_amount: 1.99,
    currency_id: "BRL",
    external_reference: chargeInput.orderId,
    point_of_interaction: {
      transaction_data: {
        qr_code: "000201PIX-COPY-PASTE",
        qr_code_base64: "aGVsbG8=",
      },
    },
  };
}

test("creates a fixed-price Pix payment with the stable order idempotency key", async () => {
  let requestedUrl = "";
  let headers = new Headers();
  let body: Record<string, unknown> | undefined;
  const provider = new MercadoPagoPixPaymentProvider("server-secret", async (url, init) => {
    requestedUrl = String(url);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(pendingResponse()), { status: 201 });
  });

  const charge = await provider.createPixPayment(chargeInput);

  assert.equal(requestedUrl, "https://api.mercadopago.com/v1/payments");
  assert.equal(headers.get("authorization"), "Bearer server-secret");
  assert.equal(headers.get("x-idempotency-key"), chargeInput.idempotencyKey);
  assert.equal(body?.transaction_amount, 1.99);
  assert.equal(body?.currency_id, undefined);
  assert.equal(body?.payment_method_id, "pix");
  assert.equal(body?.external_reference, chargeInput.orderId);
  assert.equal(body?.date_of_expiration, "2026-01-01T12:00:00.000Z");
  assert.deepEqual(body?.payer, { email: "buyer@example.com" });
  assert.deepEqual(charge, {
    providerPaymentId: "987654321",
    qrCode: "000201PIX-COPY-PASTE",
    qrCodeBase64: "aGVsbG8=",
  });
});

test("rejects provider responses that do not match the requested order and amount", async () => {
  const invalidResponses = [
    { ...pendingResponse(), external_reference: "another-order" },
    { ...pendingResponse(), transaction_amount: 19.99 },
    { ...pendingResponse(), status: "approved" },
    { ...pendingResponse(), point_of_interaction: undefined },
  ];

  for (const payload of invalidResponses) {
    const provider = new MercadoPagoPixPaymentProvider("server-secret", async () =>
      new Response(JSON.stringify(payload), { status: 201 }),
    );
    await assert.rejects(provider.createPixPayment(chargeInput), PixPaymentProviderError);
  }
});

test("does not expose Mercado Pago response bodies in provider errors", async () => {
  const provider = new MercadoPagoPixPaymentProvider("server-secret", async () =>
    new Response(JSON.stringify({ message: "sensitive provider payload" }), { status: 400 }),
  );

  await assert.rejects(
    provider.createPixPayment(chargeInput),
    (error: Error) => {
      assert.ok(error instanceof PixPaymentProviderError);
      assert.equal(error.message.includes("sensitive provider payload"), false);
      return true;
    },
  );
});

test("retrieves payment status from Mercado Pago through an authenticated server request", async () => {
  let requestedUrl = "";
  let authorization = "";
  const provider = new MercadoPagoPixPaymentProvider("server-secret", async (url, init) => {
    requestedUrl = String(url);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({
      id: 987654321,
      status: "approved",
      transaction_amount: 1.99,
      currency_id: "BRL",
      external_reference: chargeInput.orderId,
      payment_method_id: "pix",
      date_approved: "2026-01-01T01:00:00.000Z",
    }), { status: 200 });
  });

  const payment = await provider.getPaymentDetails("987654321");

  assert.equal(requestedUrl, "https://api.mercadopago.com/v1/payments/987654321");
  assert.equal(authorization, "Bearer server-secret");
  assert.deepEqual(payment, {
    paymentId: "987654321",
    status: "approved",
    transactionAmount: 1.99,
    currency: "BRL",
    externalReference: chargeInput.orderId,
    paymentMethodId: "pix",
    dateApproved: new Date("2026-01-01T01:00:00.000Z"),
  });
});

test("cancels a pending payment and confirms the terminal status with an authoritative read", async () => {
  const requests: Array<{ url: string; method: string; authorization: string; body: unknown }> = [];
  const payment = (status: string) => ({
    id: "987654321",
    status,
    transaction_amount: 1.99,
    currency_id: "BRL",
    external_reference: chargeInput.orderId,
    payment_method_id: "pix",
    date_approved: status === "approved" ? "2026-01-01T01:00:00.000Z" : null,
  });
  let readCount = 0;
  const provider = new MercadoPagoPixPaymentProvider("server-secret", async (url, init) => {
    const method = String(init?.method);
    requests.push({
      url: String(url),
      method,
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === "PUT") return new Response(JSON.stringify(payment("cancelled")), { status: 200 });
    readCount += 1;
    return new Response(JSON.stringify(payment(readCount === 1 ? "pending" : "cancelled")), { status: 200 });
  });

  const status = await provider.cancelPendingPayment("987654321", chargeInput.orderId);

  assert.equal(status, "cancelled");
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "PUT", "GET"]);
  assert.ok(requests.every(({ authorization }) => authorization === "Bearer server-secret"));
  assert.equal(requests[1]?.url, "https://api.mercadopago.com/v1/payments/987654321");
  assert.deepEqual(requests[1]?.body, { status: "cancelled" });
});

test("does not cancel or trust a payment that does not match the Curriculus order", async () => {
  const methods: string[] = [];
  const provider = new MercadoPagoPixPaymentProvider("server-secret", async (_url, init) => {
    methods.push(String(init?.method));
    return new Response(JSON.stringify({
      id: "987654321",
      status: "pending",
      transaction_amount: 9.99,
      currency_id: "BRL",
      external_reference: chargeInput.orderId,
      payment_method_id: "pix",
    }), { status: 200 });
  });

  await assert.rejects(
    provider.cancelPendingPayment("987654321", chargeInput.orderId),
    PixPaymentProviderError,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("treats an already approved payment as approved without attempting cancellation", async () => {
  const methods: string[] = [];
  const provider = new MercadoPagoPixPaymentProvider("server-secret", async (_url, init) => {
    methods.push(String(init?.method));
    return new Response(JSON.stringify({
      id: "987654321",
      status: "approved",
      transaction_amount: 1.99,
      currency_id: "BRL",
      external_reference: chargeInput.orderId,
      payment_method_id: "pix",
      date_approved: "2026-01-01T01:00:00.000Z",
    }), { status: 200 });
  });

  assert.equal(await provider.cancelPendingPayment("987654321", chargeInput.orderId), "approved");
  assert.deepEqual(methods, ["GET"]);
});
