import type {
  SessionDeletionReference,
  SessionRepository,
} from "../persistence/session-repository.js";
import type { PrivateDocumentStorage } from "../documents/private-file-document-storage.js";
import type { OrderRecord, OrderStatus } from "../persistence/session-repository.js";
import type { PendingPaymentCancellationProvider } from "../payments/pending-payment-cancellation-provider.js";

export type DataDeletionErrorCode =
  | "INVALID_SESSION"
  | "PERSISTENCE_UNAVAILABLE"
  | "DOCUMENT_STORAGE_UNAVAILABLE"
  | "PAYMENT_CANCELLATION_UNAVAILABLE"
  | "SESSION_DELETION_CONFLICT";

export class DataDeletionServiceError extends Error {
  constructor(readonly code: DataDeletionErrorCode) {
    super(code);
    this.name = "DataDeletionServiceError";
  }
}

export interface DataDeletionRepository extends Pick<
  SessionRepository,
  | "isReady"
  | "findSessionDeletionReference"
  | "deleteSessionData"
  | "findOrderBySessionId"
  | "findOrderByProviderPaymentId"
  | "updateOrderStatusByProviderPaymentId"
> {}

export type DataDeletionStorage = Pick<PrivateDocumentStorage, "delete">;

export type DataDeletionOutcome = "deleted" | "already_deleted";

export interface PendingPaymentCancellation extends Pick<PendingPaymentCancellationProvider, "cancelPendingPayment"> {}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class DataDeletionService {
  constructor(
    private readonly repository: DataDeletionRepository,
    private readonly storage: DataDeletionStorage | null,
    private readonly paymentCancellation: PendingPaymentCancellation | null = null,
  ) {}

  async deleteSessionData(sessionId: string): Promise<DataDeletionOutcome> {
    if (!isUuid(sessionId)) throw new DataDeletionServiceError("INVALID_SESSION");

    let ready = false;
    try {
      ready = await this.repository.isReady();
    } catch {
      ready = false;
    }
    if (!ready) throw new DataDeletionServiceError("PERSISTENCE_UNAVAILABLE");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let reference: SessionDeletionReference | null;
      try {
        reference = await this.repository.findSessionDeletionReference(sessionId);
      } catch {
        throw new DataDeletionServiceError("PERSISTENCE_UNAVAILABLE");
      }
      if (!reference) return "already_deleted";

      await this.cancelPendingPayment(sessionId);

      if (reference.documentStorageKey) {
        if (!this.storage) throw new DataDeletionServiceError("DOCUMENT_STORAGE_UNAVAILABLE");
        try {
          await this.storage.delete(reference.documentStorageKey);
        } catch {
          throw new DataDeletionServiceError("DOCUMENT_STORAGE_UNAVAILABLE");
        }
      }

      try {
        const deleted = await this.repository.deleteSessionData(
          sessionId,
          reference.status,
          reference.documentStorageKey,
        );
        if (deleted) return "deleted";
      } catch {
        throw new DataDeletionServiceError("PERSISTENCE_UNAVAILABLE");
      }
    }

    throw new DataDeletionServiceError("SESSION_DELETION_CONFLICT");
  }

  private async cancelPendingPayment(sessionId: string): Promise<void> {
    let order: OrderRecord | null;
    try {
      order = await this.repository.findOrderBySessionId(sessionId);
    } catch {
      throw new DataDeletionServiceError("PERSISTENCE_UNAVAILABLE");
    }
    if (!order || order.status !== "pending") return;
    if (!order.providerPaymentId || !this.paymentCancellation) {
      throw new DataDeletionServiceError("PAYMENT_CANCELLATION_UNAVAILABLE");
    }

    let resultingStatus: Exclude<OrderStatus, "pending">;
    try {
      const providerStatus = await this.paymentCancellation.cancelPendingPayment(
        order.providerPaymentId,
        order.id,
      );
      resultingStatus = providerStatus === "cancelled" ? "expired" : providerStatus;
    } catch {
      throw new DataDeletionServiceError("PAYMENT_CANCELLATION_UNAVAILABLE");
    }

    let updated = false;
    try {
      updated = await this.repository.updateOrderStatusByProviderPaymentId(
        order.providerPaymentId,
        resultingStatus,
      );
    } catch {
      throw new DataDeletionServiceError("PERSISTENCE_UNAVAILABLE");
    }
    if (updated) return;

    let latest: OrderRecord | null;
    try {
      latest = await this.repository.findOrderByProviderPaymentId(order.providerPaymentId);
    } catch {
      throw new DataDeletionServiceError("PERSISTENCE_UNAVAILABLE");
    }
    if (!latest || latest.status === "pending") {
      throw new DataDeletionServiceError("PERSISTENCE_UNAVAILABLE");
    }
  }
}
