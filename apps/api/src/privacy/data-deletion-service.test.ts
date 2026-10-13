import assert from "node:assert/strict";
import test from "node:test";
import {
  DataDeletionService,
  DataDeletionServiceError,
  type DataDeletionRepository,
  type DataDeletionStorage,
} from "./data-deletion-service.js";
import type { OrderRecord } from "../persistence/session-repository.js";

const sessionId = "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea";

class MemoryRepository implements DataDeletionRepository {
  ready = true;
  references: Array<{
    sessionId: string;
    status: "analysis_ready" | "document_ready";
    documentStorageKey: string | null;
  }> = [];
  deleteResults: boolean[] = [true];
  deletedRows: Array<{ sessionId: string; status: string; storageKey: string | null }> = [];
  order: OrderRecord | null = null;
  orderStatusUpdates: Array<{ paymentId: string; status: string }> = [];

  async isReady() { return this.ready; }
  async findSessionDeletionReference(id: string) {
    const next = this.references.shift();
    return next?.sessionId === id ? next : null;
  }
  async findOrderBySessionId(id: string) { return this.order?.sessionId === id ? this.order : null; }
  async findOrderByProviderPaymentId(id: string) {
    return this.order?.providerPaymentId === id ? this.order : null;
  }
  async updateOrderStatusByProviderPaymentId(paymentId: string, status: OrderRecord["status"]) {
    this.orderStatusUpdates.push({ paymentId, status });
    if (!this.order || this.order.providerPaymentId !== paymentId) return false;
    this.order = { ...this.order, status };
    return true;
  }
  async deleteSessionData(id: string, status: "analysis_ready" | "document_ready", storageKey: string | null) {
    this.deletedRows.push({ sessionId: id, status, storageKey });
    return this.deleteResults.shift() ?? false;
  }
}

class MemoryStorage implements DataDeletionStorage {
  calls: string[] = [];
  failure?: Error;
  async delete(key: string) {
    this.calls.push(key);
    if (this.failure) throw this.failure;
  }
}

function makePendingOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "7fcf1fc0-23fc-45c4-a088-79e7bd09f293",
    sessionId,
    amountCents: 199,
    currency: "BRL",
    status: "pending",
    providerPaymentId: "987654321",
    pixQrCode: "pix",
    pixQrCodeBase64: "base64",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    checkoutExpiresAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

const cancelPayment = {
  async cancelPendingPayment() { return "cancelled" as const; },
};

test("deletes an unpaid analysis session immediately without touching financial records", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "analysis_ready", documentStorageKey: null }];
  const storage = new MemoryStorage();
  const service = new DataDeletionService(repository, storage);

  assert.equal(await service.deleteSessionData(sessionId), "deleted");
  assert.deepEqual(repository.deletedRows, [{ sessionId, status: "analysis_ready", storageKey: null }]);
  assert.deepEqual(storage.calls, []);
});

test("cancels a pending Pix and records its terminal state before deleting the session", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "analysis_ready", documentStorageKey: null }];
  repository.order = makePendingOrder();
  const events: string[] = [];
  repository.updateOrderStatusByProviderPaymentId = async (paymentId, status) => {
    events.push(`order:${paymentId}:${status}`);
    return true;
  };
  repository.deleteSessionData = async () => { events.push("session"); return true; };
  const cancellation = {
    async cancelPendingPayment(paymentId: string, orderId: string) {
      events.push(`cancel:${paymentId}:${orderId}`);
      return "cancelled" as const;
    },
  };
  const service = new DataDeletionService(repository, new MemoryStorage(), cancellation);

  assert.equal(await service.deleteSessionData(sessionId), "deleted");
  assert.deepEqual(events, [
    `cancel:987654321:${repository.order.id}`,
    "order:987654321:expired",
    "session",
  ]);
});

test("does not delete session data when a pending Pix cannot be cancelled", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "analysis_ready", documentStorageKey: null }];
  repository.order = makePendingOrder();
  const cancellation = {
    async cancelPendingPayment() { throw new Error("provider details must not escape"); },
  };
  const service = new DataDeletionService(repository, new MemoryStorage(), cancellation);

  await assert.rejects(
    service.deleteSessionData(sessionId),
    (error: Error) => error instanceof DataDeletionServiceError && error.code === "PAYMENT_CANCELLATION_UNAVAILABLE",
  );
  assert.deepEqual(repository.deletedRows, []);
});

test("does not delete session data for an in-flight order that has no provider payment ID yet", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "analysis_ready", documentStorageKey: null }];
  repository.order = makePendingOrder({ providerPaymentId: null });
  const service = new DataDeletionService(repository, new MemoryStorage(), cancelPayment);

  await assert.rejects(
    service.deleteSessionData(sessionId),
    (error: Error) => error instanceof DataDeletionServiceError && error.code === "PAYMENT_CANCELLATION_UNAVAILABLE",
  );
  assert.deepEqual(repository.deletedRows, []);
});

test("keeps an approved payment record separate and does not attempt an automatic refund", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "analysis_ready", documentStorageKey: null }];
  repository.order = makePendingOrder({ status: "approved" });
  let cancellationCalls = 0;
  const cancellation = {
    async cancelPendingPayment() { cancellationCalls += 1; return "cancelled" as const; },
  };
  const service = new DataDeletionService(repository, new MemoryStorage(), cancellation);

  assert.equal(await service.deleteSessionData(sessionId), "deleted");
  assert.equal(cancellationCalls, 0);
  assert.deepEqual(repository.orderStatusUpdates, []);
  assert.equal(repository.order?.status, "approved");
});

test("preserves a payment that becomes approved while cancellation is in flight", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "analysis_ready", documentStorageKey: null }];
  repository.order = makePendingOrder();
  const cancellation = { async cancelPendingPayment() { return "approved" as const; } };
  const service = new DataDeletionService(repository, new MemoryStorage(), cancellation);

  assert.equal(await service.deleteSessionData(sessionId), "deleted");
  assert.deepEqual(repository.orderStatusUpdates, [{ paymentId: "987654321", status: "approved" }]);
});

test("deletes a generated PDF before deleting its Neon session reference", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "document_ready", documentStorageKey: "private.pdf" }];
  const storage = new MemoryStorage();
  const events: string[] = [];
  storage.delete = async (key) => { events.push(`file:${key}`); };
  repository.deleteSessionData = async (id, status, key) => {
    events.push(`row:${id}:${status}:${key}`);
    return true;
  };
  const service = new DataDeletionService(repository, storage);

  assert.equal(await service.deleteSessionData(sessionId), "deleted");
  assert.deepEqual(events, [`file:private.pdf`, `row:${sessionId}:document_ready:private.pdf`]);
});

test("keeps the session row when private file deletion fails", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "document_ready", documentStorageKey: "private.pdf" }];
  const storage = new MemoryStorage();
  storage.failure = new Error("storage failure details");
  const service = new DataDeletionService(repository, storage);

  await assert.rejects(
    service.deleteSessionData(sessionId),
    (error: Error) => error instanceof DataDeletionServiceError && error.code === "DOCUMENT_STORAGE_UNAVAILABLE",
  );
  assert.deepEqual(repository.deletedRows, []);
});

test("re-reads a session after a concurrent document generation changes its state", async () => {
  const repository = new MemoryRepository();
  repository.references = [
    { sessionId, status: "analysis_ready", documentStorageKey: null },
    { sessionId, status: "document_ready", documentStorageKey: "new.pdf" },
  ];
  repository.deleteResults = [false, true];
  const storage = new MemoryStorage();
  const service = new DataDeletionService(repository, storage);

  assert.equal(await service.deleteSessionData(sessionId), "deleted");
  assert.deepEqual(storage.calls, ["new.pdf"]);
  assert.equal(repository.deletedRows.length, 2);
});

test("treats repeated deletion as successful and rejects malformed session IDs", async () => {
  const repository = new MemoryRepository();
  const service = new DataDeletionService(repository, new MemoryStorage());

  assert.equal(await service.deleteSessionData(sessionId), "already_deleted");
  await assert.rejects(
    service.deleteSessionData("not-a-session"),
    (error: Error) => error instanceof DataDeletionServiceError && error.code === "INVALID_SESSION",
  );
});

test("does not remove a document row if private storage is unavailable", async () => {
  const repository = new MemoryRepository();
  repository.references = [{ sessionId, status: "document_ready", documentStorageKey: "private.pdf" }];
  const service = new DataDeletionService(repository, null);

  await assert.rejects(
    service.deleteSessionData(sessionId),
    (error: Error) => error instanceof DataDeletionServiceError && error.code === "DOCUMENT_STORAGE_UNAVAILABLE",
  );
  assert.deepEqual(repository.deletedRows, []);
});
