import assert from "node:assert/strict";
import test from "node:test";
import { EphemeralSessionRepository } from "./ephemeral-session-repository.js";

const createSessionInput = {
  jobDescription: "Vaga sintética",
  resume: "Currículo sintético",
  dataNoticeAcknowledged: true as const,
  analysis: {
    jobRequirements: [],
    suggestions: [],
    documentStructure: { sectionOrder: [], suggestionOrder: [] },
  },
  usage: { inputTokens: 5, outputTokens: 8, totalTokens: 13, estimatedCostUsd: null },
};

test("stores analysis sessions in memory with a 24-hour expiry and reclaims expired content", async () => {
  let now = Date.UTC(2026, 0, 1);
  const repository = new EphemeralSessionRepository(() => now);
  const reference = await repository.createSession(createSessionInput);

  assert.equal((await repository.findActiveSession(reference.id))?.resume, "Currículo sintético");
  assert.equal(reference.expiresAt.getTime() - now, 24 * 60 * 60_000);
  now += 24 * 60 * 60_000;
  assert.equal(await repository.findActiveSession(reference.id), null);
  assert.equal(await repository.deleteExpiredSessions(), 1);
  assert.equal(await repository.findSessionDeletionReference(reference.id), null);
});

test("keeps orders separate, clears source content after approved document generation, and detaches financial metadata on deletion", async () => {
  const repository = new EphemeralSessionRepository(() => Date.UTC(2026, 0, 1));
  const session = await repository.createSession(createSessionInput);
  const order = await repository.createPendingOrder(session.id);
  assert.ok(order);
  assert.equal(order.amountCents, 199);
  assert.equal("payerEmail" in order, false);

  assert.equal(await repository.savePixPayment(order.id, {
    providerPaymentId: "synthetic-payment-1",
    qrCode: "synthetic-pix",
    qrCodeBase64: "cG5n",
  }), true);
  assert.equal(await repository.updateOrderStatusByProviderPaymentId("synthetic-payment-1", "approved"), true);

  const storageKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf";
  assert.equal(await repository.markDocumentGenerated(session.id, storageKey), true);
  assert.equal(await repository.findActiveSession(session.id), null);
  assert.deepEqual(await repository.findGeneratedDocument(session.id), {
    sessionId: session.id,
    storageKey,
    expiresAt: new Date(Date.UTC(2026, 0, 2)),
  });
  assert.deepEqual(await repository.findSessionDeletionReference(session.id), {
    sessionId: session.id,
    status: "document_ready",
    documentStorageKey: storageKey,
  });

  assert.equal(await repository.deleteSessionData(session.id, "document_ready", storageKey), true);
  assert.equal(await repository.findSessionDeletionReference(session.id), null);
  assert.equal((await repository.findOrder(order.id))?.sessionId, null);
  assert.equal((await repository.findOrder(order.id))?.status, "approved");
});

test("does not generate a second order for a session or approve documents before payment approval", async () => {
  const repository = new EphemeralSessionRepository();
  const session = await repository.createSession(createSessionInput);
  const first = await repository.createPendingOrder(session.id);
  const retry = await repository.createPendingOrder(session.id);

  assert.equal(retry?.id, first?.id);
  assert.equal(await repository.markDocumentGenerated(session.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf"), false);
});
