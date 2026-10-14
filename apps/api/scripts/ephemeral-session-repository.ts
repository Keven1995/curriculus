import { randomUUID } from "node:crypto";
import type {
  CreateAnalysisSession,
  ExpiredDocumentReference,
  GeneratedDocumentReference,
  OrderRecord,
  OrderStatus,
  SessionDeletionReference,
  SessionReference,
  SessionRepository,
  StoredAnalysisSession,
} from "../src/persistence/session-repository.js";

type SessionEntry = {
  status: "analysis_ready" | "document_ready";
  analysis: StoredAnalysisSession | null;
  document: GeneratedDocumentReference | null;
};

/** Local-only, non-persistent repository. Never use this adapter for deployed services. */
export class EphemeralSessionRepository implements SessionRepository {
  readonly sessions = new Map<string, SessionEntry>();
  readonly orders = new Map<string, OrderRecord>();
  readonly orderIdsBySession = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  async isReady(): Promise<boolean> {
    return true;
  }

  async createSession(input: CreateAnalysisSession): Promise<SessionReference> {
    const createdAt = new Date(this.now());
    const reference = {
      id: randomUUID(),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60_000),
    };
    const session: StoredAnalysisSession = { ...input, ...reference, status: "analysis_ready" };
    this.sessions.set(reference.id, { status: "analysis_ready", analysis: session, document: null });
    return reference;
  }

  async findActiveSession(id: string): Promise<StoredAnalysisSession | null> {
    const session = this.sessions.get(id)?.analysis;
    return session && session.expiresAt.getTime() > this.now() ? session : null;
  }

  async findSessionDeletionReference(id: string): Promise<SessionDeletionReference | null> {
    const entry = this.sessions.get(id);
    if (!entry) return null;
    return {
      sessionId: id,
      status: entry.status,
      documentStorageKey: entry.document?.storageKey ?? null,
    };
  }

  async deleteSessionData(
    id: string,
    expectedStatus: SessionDeletionReference["status"],
    expectedStorageKey: string | null,
  ): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (
      !entry ||
      entry.status !== expectedStatus ||
      (entry.document?.storageKey ?? null) !== expectedStorageKey
    ) {
      return false;
    }
    this.sessions.delete(id);
    for (const order of this.orders.values()) {
      if (order.sessionId === id) order.sessionId = null;
    }
    return true;
  }

  async deleteExpiredSessions(): Promise<number> {
    let deleted = 0;
    for (const [id, entry] of this.sessions) {
      if (
        entry.status === "analysis_ready" &&
        entry.analysis &&
        entry.analysis.expiresAt.getTime() <= this.now()
      ) {
        this.sessions.delete(id);
        for (const order of this.orders.values()) {
          if (order.sessionId === id) order.sessionId = null;
        }
        deleted += 1;
      }
    }
    return deleted;
  }

  async findExpiredDocuments(): Promise<ExpiredDocumentReference[]> {
    const expired: ExpiredDocumentReference[] = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.document && entry.document.expiresAt.getTime() <= this.now()) {
        expired.push({
          sessionId,
          storageKey: entry.document.storageKey,
          expiresAt: entry.document.expiresAt,
        });
      }
    }
    return expired;
  }

  async findActiveDocumentStorageKeys(): Promise<string[]> {
    return [...this.sessions.values()].flatMap((entry) =>
      entry.document && entry.document.expiresAt.getTime() > this.now()
        ? [entry.document.storageKey]
        : [],
    );
  }

  async deleteExpiredDocumentRecord(id: string): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (!entry?.document || entry.document.expiresAt.getTime() > this.now()) return false;
    this.sessions.delete(id);
    for (const order of this.orders.values()) {
      if (order.sessionId === id) order.sessionId = null;
    }
    return true;
  }

  async markDocumentGenerated(id: string, storageKey: string): Promise<boolean> {
    if (!storageKey.trim()) return false;
    const entry = this.sessions.get(id);
    const order = await this.findOrderBySessionId(id);
    if (
      !entry?.analysis ||
      entry.analysis.expiresAt.getTime() <= this.now() ||
      order?.status !== "approved"
    ) {
      return false;
    }
    const document: GeneratedDocumentReference = {
      sessionId: id,
      storageKey,
      expiresAt: new Date(this.now() + 24 * 60 * 60_000),
    };
    entry.status = "document_ready";
    entry.analysis = null;
    entry.document = document;
    return true;
  }

  async findGeneratedDocument(id: string): Promise<GeneratedDocumentReference | null> {
    const document = this.sessions.get(id)?.document;
    return document && document.expiresAt.getTime() > this.now() ? document : null;
  }

  async createPendingOrder(sessionId: string): Promise<OrderRecord | null> {
    if (!(await this.findActiveSession(sessionId))) return null;
    const existing = await this.findOrderBySessionId(sessionId);
    if (existing) return existing;
    const createdAt = new Date(this.now());
    const order: OrderRecord = {
      id: randomUUID(),
      sessionId,
      amountCents: 199,
      currency: "BRL",
      status: "pending",
      providerPaymentId: null,
      pixQrCode: null,
      pixQrCodeBase64: null,
      createdAt,
      updatedAt: createdAt,
      checkoutExpiresAt: new Date(createdAt.getTime() + 60 * 60_000),
    };
    this.orders.set(order.id, order);
    this.orderIdsBySession.set(sessionId, order.id);
    return order;
  }

  async savePixPayment(
    orderId: string,
    charge: { providerPaymentId: string; qrCode: string; qrCodeBase64: string },
  ): Promise<boolean> {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "pending") return false;
    order.providerPaymentId = charge.providerPaymentId;
    order.pixQrCode = charge.qrCode;
    order.pixQrCodeBase64 = charge.qrCodeBase64;
    order.updatedAt = new Date(this.now());
    return true;
  }

  async findOrderByProviderPaymentId(id: string): Promise<OrderRecord | null> {
    return [...this.orders.values()].find((order) => order.providerPaymentId === id) ?? null;
  }

  async findOrderBySessionId(id: string): Promise<OrderRecord | null> {
    return [...this.orders.values()].find((order) => order.sessionId === id) ?? null;
  }

  async attachProviderPaymentId(orderId: string, paymentId: string): Promise<boolean> {
    const order = this.orders.get(orderId);
    if (
      !order ||
      order.status !== "pending" ||
      (order.providerPaymentId !== null && order.providerPaymentId !== paymentId)
    ) {
      return false;
    }
    order.providerPaymentId = paymentId;
    return true;
  }

  async updateOrderStatusByProviderPaymentId(paymentId: string, status: OrderStatus): Promise<boolean> {
    const order = await this.findOrderByProviderPaymentId(paymentId);
    if (!order || order.status !== "pending") return false;
    order.status = status;
    order.updatedAt = new Date(this.now());
    return true;
  }

  async findOrder(id: string): Promise<OrderRecord | null> {
    return this.orders.get(id) ?? null;
  }

  async close(): Promise<void> {}
}
