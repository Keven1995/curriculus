import assert from "node:assert/strict";
import test from "node:test";
import {
  PixPaymentService,
  type PixPaymentRepository,
} from "./pix-payment-service.js";
import type { OrderRecord } from "../persistence/session-repository.js";
import type { PixPaymentProvider } from "./pix-payment-provider.js";
import { PixPaymentError } from "./payment-errors.js";

const expiresAt = new Date("2026-01-01T12:00:00.000Z");

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "order-test-id",
    sessionId: "session-test-id",
    amountCents: 199,
    currency: "BRL",
    status: "pending",
    providerPaymentId: null,
    pixQrCode: null,
    pixQrCodeBase64: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    checkoutExpiresAt: expiresAt,
    ...overrides,
  };
}

class FakePaymentRepository implements PixPaymentRepository {
  order: OrderRecord | null = makeOrder();
  ready = true;
  saves: Array<{ orderId: string; charge: { providerPaymentId: string; qrCode: string; qrCodeBase64: string } }> = [];

  async isReady() {
    return this.ready;
  }

  async createPendingOrder() {
    return this.order;
  }

  async savePixPayment(orderId: string, charge: { providerPaymentId: string; qrCode: string; qrCodeBase64: string }) {
    this.saves.push({ orderId, charge });
    if (!this.order) return false;
    this.order = makeOrder({
      ...this.order,
      providerPaymentId: charge.providerPaymentId,
      pixQrCode: charge.qrCode,
      pixQrCodeBase64: charge.qrCodeBase64,
    });
    return true;
  }
}

class FakePixProvider implements PixPaymentProvider {
  calls: Array<Parameters<PixPaymentProvider["createPixPayment"]>[0]> = [];
  result = {
    providerPaymentId: "payment-test-id",
    qrCode: "pix-code",
    qrCodeBase64: "base64-code",
  };

  async createPixPayment(input: Parameters<PixPaymentProvider["createPixPayment"]>[0]) {
    this.calls.push(input);
    return this.result;
  }
}

test("creates and persists one fixed-price pending Pix charge for an active session", async () => {
  const repository = new FakePaymentRepository();
  const provider = new FakePixProvider();
  const service = new PixPaymentService(repository, provider, () => new Date("2026-01-01T00:00:00.000Z"));

  const result = await service.createPixPayment("session-test-id", "buyer@example.com");

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]!.orderId, "order-test-id");
  assert.equal(provider.calls[0]!.idempotencyKey, "order-test-id");
  assert.equal(provider.calls[0]!.amountCents, 199);
  assert.equal(provider.calls[0]!.payerEmail, "buyer@example.com");
  assert.equal(repository.saves.length, 1);
  assert.deepEqual(repository.saves[0], {
    orderId: "order-test-id",
    charge: provider.result,
  });
  assert.deepEqual(result, {
    orderId: "order-test-id",
    amountCents: 199,
    currency: "BRL",
    status: "pending",
    expiresAt,
    qrCode: "pix-code",
    qrCodeBase64: "base64-code",
  });
});

test("returns a stored pending charge on retries without calling the provider again", async () => {
  const repository = new FakePaymentRepository();
  repository.order = makeOrder({
    providerPaymentId: "payment-saved-id",
    pixQrCode: "saved-code",
    pixQrCodeBase64: "saved-image",
  });
  const provider = new FakePixProvider();
  const service = new PixPaymentService(repository, provider, () => new Date("2026-01-01T00:00:00.000Z"));

  const result = await service.createPixPayment("session-test-id", "buyer@example.com");

  assert.equal(provider.calls.length, 0);
  assert.equal(result.qrCode, "saved-code");
  assert.equal(result.qrCodeBase64, "saved-image");
});

test("maps provider failures to a safe payment error and does not save a partial charge", async () => {
  const repository = new FakePaymentRepository();
  const provider = new FakePixProvider();
  provider.createPixPayment = async () => {
    throw new Error("sensitive provider response");
  };
  const service = new PixPaymentService(repository, provider, () => new Date("2026-01-01T00:00:00.000Z"));

  await assert.rejects(
    service.createPixPayment("session-test-id", "buyer@example.com"),
    (error: Error) => {
      assert.ok(error instanceof PixPaymentError);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.message.includes("sensitive provider response"), false);
      return true;
    },
  );
  assert.equal(repository.saves.length, 0);
});

test("fails closed for unavailable storage, expired sessions, terminal orders, and too-short checkout windows", async () => {
  const repository = new FakePaymentRepository();
  const provider = new FakePixProvider();
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const service = new PixPaymentService(repository, provider, now);

  repository.ready = false;
  await assert.rejects(service.createPixPayment("session-test-id", "buyer@example.com"), (error: Error) =>
    error instanceof PixPaymentError && error.code === "PERSISTENCE_UNAVAILABLE",
  );

  repository.ready = true;
  repository.order = null;
  await assert.rejects(service.createPixPayment("session-test-id", "buyer@example.com"), (error: Error) =>
    error instanceof PixPaymentError && error.code === "SESSION_NOT_PAYABLE",
  );

  repository.order = makeOrder({ status: "approved" });
  await assert.rejects(service.createPixPayment("session-test-id", "buyer@example.com"), (error: Error) =>
    error instanceof PixPaymentError && error.code === "ORDER_NOT_PENDING",
  );

  repository.order = makeOrder({ checkoutExpiresAt: new Date("2026-01-01T00:20:00.000Z") });
  await assert.rejects(service.createPixPayment("session-test-id", "buyer@example.com"), (error: Error) =>
    error instanceof PixPaymentError && error.code === "CHECKOUT_WINDOW_TOO_SHORT",
  );
  assert.equal(provider.calls.length, 0);
});
