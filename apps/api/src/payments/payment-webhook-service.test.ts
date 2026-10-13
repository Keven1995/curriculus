import assert from "node:assert/strict";
import test from "node:test";
import type { OrderRecord, OrderStatus } from "../persistence/session-repository.js";
import {
  PaymentWebhookError,
  PaymentWebhookService,
  type PaymentWebhookRepository,
} from "./payment-webhook-service.js";
import type { ProviderPaymentDetails, PaymentStatusProvider } from "./payment-status-provider.js";

const order: OrderRecord = {
  id: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
  sessionId: "session-test-id",
  amountCents: 199,
  currency: "BRL",
  status: "pending",
  providerPaymentId: "123456789",
  pixQrCode: "pix-code",
  pixQrCodeBase64: "base64-code",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  checkoutExpiresAt: new Date("2026-01-02T00:00:00.000Z"),
};

function approvedPayment(overrides: Partial<ProviderPaymentDetails> = {}): ProviderPaymentDetails {
  return {
    paymentId: "123456789",
    status: "approved",
    transactionAmount: 1.99,
    currency: "BRL",
    externalReference: order.id,
    paymentMethodId: "pix",
    dateApproved: new Date("2026-01-01T01:00:00.000Z"),
    ...overrides,
  };
}

class FakeWebhookRepository implements PaymentWebhookRepository {
  ready = true;
  currentOrder: OrderRecord | null = order;
  lookupCalls = 0;
  updates: Array<{ providerPaymentId: string; status: OrderStatus }> = [];
  attachments: Array<{ orderId: string; providerPaymentId: string }> = [];

  async isReady() {
    return this.ready;
  }

  async findOrderByProviderPaymentId(providerPaymentId: string) {
    this.lookupCalls += 1;
    return this.currentOrder?.providerPaymentId === providerPaymentId ? this.currentOrder : null;
  }

  async findOrder(orderId: string) {
    return this.currentOrder?.id === orderId ? this.currentOrder : null;
  }

  async attachProviderPaymentId(orderId: string, providerPaymentId: string) {
    this.attachments.push({ orderId, providerPaymentId });
    if (
      this.currentOrder?.id !== orderId ||
      this.currentOrder.status !== "pending" ||
      (this.currentOrder.providerPaymentId !== null && this.currentOrder.providerPaymentId !== providerPaymentId)
    ) {
      return false;
    }
    this.currentOrder = { ...this.currentOrder, providerPaymentId };
    return true;
  }

  async updateOrderStatusByProviderPaymentId(providerPaymentId: string, status: OrderStatus) {
    this.updates.push({ providerPaymentId, status });
    if (this.currentOrder?.providerPaymentId !== providerPaymentId) return false;
    const current = this.currentOrder.status;
    const mayTransition = current === status || current === "pending" || (current === "approved" && status === "refunded");
    if (!mayTransition) return false;
    this.currentOrder = { ...this.currentOrder, status };
    return true;
  }
}

class FakeStatusProvider implements PaymentStatusProvider {
  calls: string[] = [];
  result = approvedPayment();
  failure?: Error;

  async getPaymentDetails(paymentId: string) {
    this.calls.push(paymentId);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

test("queries Mercado Pago and approves only an associated, matching Pix payment", async () => {
  const repository = new FakeWebhookRepository();
  const provider = new FakeStatusProvider();
  const service = new PaymentWebhookService(repository, provider);

  const result = await service.handlePaymentNotification("123456789");

  assert.equal(result, "processed");
  assert.deepEqual(provider.calls, ["123456789"]);
  assert.deepEqual(repository.updates, [{ providerPaymentId: "123456789", status: "approved" }]);
  assert.equal(repository.currentOrder?.status, "approved");
});

test("recovers the order association from the provider external reference after a local save failure", async () => {
  const repository = new FakeWebhookRepository();
  repository.currentOrder = { ...order, providerPaymentId: null };
  const provider = new FakeStatusProvider();
  const service = new PaymentWebhookService(repository, provider);

  const result = await service.handlePaymentNotification("123456789");

  assert.equal(result, "processed");
  assert.deepEqual(repository.attachments, [{ orderId: order.id, providerPaymentId: "123456789" }]);
  assert.equal(repository.currentOrder?.providerPaymentId, "123456789");
  assert.equal(repository.currentOrder?.status, "approved");
});

test("ignores unmatched or mismatched provider payments without changing the order", async () => {
  const badPayments = [
    approvedPayment({ paymentId: "different-id" }),
    approvedPayment({ externalReference: "another-order" }),
    approvedPayment({ transactionAmount: 9.99 }),
    approvedPayment({ currency: "USD" }),
    approvedPayment({ paymentMethodId: "credit_card" }),
    approvedPayment({ dateApproved: new Date("2026-01-03T00:00:00.000Z") }),
    approvedPayment({ status: "some_unknown_state" }),
  ];

  for (const result of badPayments) {
    const repository = new FakeWebhookRepository();
    const provider = new FakeStatusProvider();
    provider.result = result;
    const service = new PaymentWebhookService(repository, provider);

    assert.equal(await service.handlePaymentNotification("123456789"), "ignored");
    assert.equal(repository.updates.length, 0);
    assert.equal(repository.currentOrder?.status, "pending");
  }

  const repository = new FakeWebhookRepository();
  repository.currentOrder = null;
  const provider = new FakeStatusProvider();
  const service = new PaymentWebhookService(repository, provider);
  assert.equal(await service.handlePaymentNotification("123456789"), "ignored");
  assert.equal(provider.calls.length, 1);
});

test("keeps non-approved provider states non-approved and processes duplicate notifications idempotently", async () => {
  const repository = new FakeWebhookRepository();
  const provider = new FakeStatusProvider();
  const service = new PaymentWebhookService(repository, provider);

  provider.result = approvedPayment({ status: "pending", dateApproved: null });
  assert.equal(await service.handlePaymentNotification("123456789"), "processed");
  assert.equal(repository.currentOrder?.status, "pending");

  provider.result = approvedPayment({ status: "rejected", dateApproved: null });
  assert.equal(await service.handlePaymentNotification("123456789"), "processed");
  assert.equal(repository.currentOrder?.status, "rejected");

  provider.result = approvedPayment({ status: "approved" });
  assert.equal(await service.handlePaymentNotification("123456789"), "ignored");
  assert.equal(repository.currentOrder?.status, "rejected");
});

test("replaying an approved notification keeps the order approved without a second state transition", async () => {
  const repository = new FakeWebhookRepository();
  const provider = new FakeStatusProvider();
  const service = new PaymentWebhookService(repository, provider);

  assert.equal(await service.handlePaymentNotification("123456789"), "processed");
  assert.equal(await service.handlePaymentNotification("123456789"), "processed");
  assert.equal(repository.currentOrder?.status, "approved");
  assert.deepEqual(repository.updates, [
    { providerPaymentId: "123456789", status: "approved" },
    { providerPaymentId: "123456789", status: "approved" },
  ]);
});

test("maps database and provider failures to safe retryable webhook errors", async () => {
  const repository = new FakeWebhookRepository();
  const provider = new FakeStatusProvider();
  const service = new PaymentWebhookService(repository, provider);

  repository.ready = false;
  await assert.rejects(service.handlePaymentNotification("123456789"), (error: Error) =>
    error instanceof PaymentWebhookError && error.code === "PERSISTENCE_UNAVAILABLE",
  );

  repository.ready = true;
  provider.failure = new Error("private provider response");
  await assert.rejects(service.handlePaymentNotification("123456789"), (error: Error) => {
    assert.ok(error instanceof PaymentWebhookError);
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(error.message.includes("private provider response"), false);
    return true;
  });
});
