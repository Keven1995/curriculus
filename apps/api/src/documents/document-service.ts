import { randomUUID } from "node:crypto";
import type { AnalysisOutput } from "../analyses/analysis-output.js";
import type {
  ExpiredDocumentReference,
  OrderRecord,
  SessionRepository,
  StoredAnalysisSession,
} from "../persistence/session-repository.js";
import { createDocumentAccessToken, verifyDocumentAccessToken } from "./document-access-token.js";
import { ApprovedSuggestionsError, buildFinalResume, validateFinalResumeText } from "./document-content.js";
import { renderResumePdf } from "./pdf-renderer.js";
import { renderLayoutTextResumePdf } from "../resume-layout/layout-text-pdf-renderer.js";
import type { ResumeLayoutTemplate } from "../resume-layout/resume-layout-types.js";

export type DocumentServiceErrorCode =
  | "PERSISTENCE_UNAVAILABLE"
  | "SESSION_NOT_AVAILABLE"
  | "PAYMENT_NOT_APPROVED"
  | "INVALID_APPROVED_SUGGESTIONS"
  | "INVALID_FINAL_RESUME"
  | "DOCUMENT_RENDER_FAILED"
  | "DOCUMENT_STORAGE_UNAVAILABLE"
  | "DOCUMENT_NOT_AVAILABLE";

export class DocumentServiceError extends Error {
  constructor(readonly code: DocumentServiceErrorCode) {
    super(code);
    this.name = "DocumentServiceError";
  }
}

export type StoredDocumentReference = {
  sessionId: string;
  storageKey: string;
  expiresAt: Date;
  layoutFallback?: boolean;
};

export interface DocumentRepository extends Pick<
  SessionRepository,
  | "isReady"
  | "findActiveSession"
  | "findOrderBySessionId"
  | "findGeneratedDocument"
  | "findExpiredDocuments"
  | "findActiveDocumentStorageKeys"
  | "deleteExpiredDocumentRecord"
  | "markDocumentGenerated"
> {}

export interface PrivateDocumentStorage {
  write(key: string, contents: Buffer): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  list(): Promise<Array<{ key: string; modifiedAt: Date }>>;
  delete(key: string): Promise<void>;
}

export type GeneratedDocumentResponse = {
  format: "pdf";
  downloadPath: string;
  expiresAt: Date;
  created: boolean;
  layoutFallback: boolean;
};

export type PdfRenderer = (resume: string, layoutTemplate?: ResumeLayoutTemplate) => Promise<Buffer>;

async function renderSessionResumePdf(resume: string, layoutTemplate?: ResumeLayoutTemplate): Promise<Buffer> {
  return layoutTemplate
    ? renderLayoutTextResumePdf(layoutTemplate, resume)
    : renderResumePdf(resume);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isOrderApproved(order: OrderRecord | null): boolean {
  return order?.status === "approved" && order.sessionId !== null;
}

export class DocumentService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly storage: PrivateDocumentStorage,
    private readonly accessSecret: string,
    private readonly renderPdf: PdfRenderer = renderSessionResumePdf,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (Buffer.byteLength(accessSecret, "utf8") < 32) {
      throw new Error("Document download secret must contain at least 32 bytes.");
    }
  }

  private responseFor(reference: StoredDocumentReference, created: boolean): GeneratedDocumentResponse {
    const token = createDocumentAccessToken(this.accessSecret, reference.sessionId, reference.expiresAt);
    return {
      format: "pdf",
      downloadPath: `/documents/${encodeURIComponent(reference.sessionId)}?token=${encodeURIComponent(token)}`,
      expiresAt: reference.expiresAt,
      created,
      layoutFallback: reference.layoutFallback ?? false,
    };
  }

  private async ensureRepositoryReady(): Promise<void> {
    let ready = false;
    try {
      ready = await this.repository.isReady();
    } catch {
      ready = false;
    }
    if (!ready) throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
  }

  async generateDocument(
    sessionId: string,
    approvedSuggestionIds: readonly string[],
    requestedFinalResumeText?: string,
  ): Promise<GeneratedDocumentResponse> {
    if (!isUuid(sessionId)) throw new DocumentServiceError("SESSION_NOT_AVAILABLE");
    await this.ensureRepositoryReady();

    let existing: StoredDocumentReference | null;
    try {
      existing = await this.repository.findGeneratedDocument(sessionId);
    } catch {
      throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
    }
    if (existing) return this.responseFor(existing, false);

    let order: OrderRecord | null;
    let session: StoredAnalysisSession | null;
    try {
      order = await this.repository.findOrderBySessionId(sessionId);
      if (!isOrderApproved(order)) throw new DocumentServiceError("PAYMENT_NOT_APPROVED");
      session = await this.repository.findActiveSession(sessionId);
    } catch (error) {
      if (error instanceof DocumentServiceError) throw error;
      throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
    }
    if (!session) throw new DocumentServiceError("SESSION_NOT_AVAILABLE");

    let finalResume: string;
    try {
      const approvedResume = buildFinalResume(session.resume, session.analysis, approvedSuggestionIds);
      if (requestedFinalResumeText === undefined) {
        finalResume = approvedResume;
      } else {
        const validatedFinalResume = validateFinalResumeText(requestedFinalResumeText);
        if (validatedFinalResume === undefined) throw new DocumentServiceError("INVALID_FINAL_RESUME");
        finalResume = validatedFinalResume;
      }
    } catch (error) {
      if (error instanceof DocumentServiceError) throw error;
      if (error instanceof ApprovedSuggestionsError) {
        throw new DocumentServiceError("INVALID_APPROVED_SUGGESTIONS");
      }
      throw error;
    }

    let pdf: Buffer;
    let layoutFallback = false;
    try {
      pdf = await this.renderPdf(finalResume, session.resumeLayoutTemplate);
    } catch {
      if (!session.resumeLayoutTemplate) throw new DocumentServiceError("DOCUMENT_RENDER_FAILED");
      try {
        pdf = await this.renderPdf(finalResume);
        layoutFallback = true;
      } catch {
        throw new DocumentServiceError("DOCUMENT_RENDER_FAILED");
      }
    }

    const storageKey = `${randomUUID()}.pdf`;
    try {
      await this.storage.write(storageKey, pdf);
    } catch {
      await this.deleteQuietly(storageKey);
      throw new DocumentServiceError("DOCUMENT_STORAGE_UNAVAILABLE");
    }

    let marked: boolean;
    try {
      marked = await this.repository.markDocumentGenerated(sessionId, storageKey, layoutFallback);
    } catch {
      await this.deleteQuietly(storageKey);
      throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
    }

    if (!marked) {
      await this.deleteQuietly(storageKey);
      try {
        existing = await this.repository.findGeneratedDocument(sessionId);
      } catch {
        throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
      }
      if (existing) return this.responseFor(existing, false);
      throw new DocumentServiceError("PAYMENT_NOT_APPROVED");
    }

    let generated: StoredDocumentReference | null;
    try {
      generated = await this.repository.findGeneratedDocument(sessionId);
    } catch {
      throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
    }
    if (!generated) throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
    return this.responseFor(generated, true);
  }

  async downloadDocument(sessionId: string, token: string): Promise<Buffer> {
    const expiry = verifyDocumentAccessToken(this.accessSecret, token, sessionId, this.now());
    if (!expiry) throw new DocumentServiceError("DOCUMENT_NOT_AVAILABLE");
    await this.ensureRepositoryReady();

    let reference: StoredDocumentReference | null;
    try {
      reference = await this.repository.findGeneratedDocument(sessionId);
    } catch {
      throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
    }
    if (!reference || reference.expiresAt.getTime() !== expiry.getTime()) {
      throw new DocumentServiceError("DOCUMENT_NOT_AVAILABLE");
    }

    try {
      const contents = await this.storage.read(reference.storageKey);
      if (!contents) throw new DocumentServiceError("DOCUMENT_NOT_AVAILABLE");
      return contents;
    } catch (error) {
      if (error instanceof DocumentServiceError) throw error;
      throw new DocumentServiceError("DOCUMENT_STORAGE_UNAVAILABLE");
    }
  }

  async deleteExpiredDocuments(): Promise<number> {
    await this.ensureRepositoryReady();
    let expired: ExpiredDocumentReference[];
    try {
      expired = await this.repository.findExpiredDocuments();
    } catch {
      throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
    }

    let deletedCount = 0;
    for (const reference of expired) {
      try {
        await this.storage.delete(reference.storageKey);
        if (await this.repository.deleteExpiredDocumentRecord(reference.sessionId)) deletedCount += 1;
      } catch {
        // Keep the database reference so a later cleanup pass can retry safely.
      }
    }

    let activeKeys: string[];
    try {
      activeKeys = await this.repository.findActiveDocumentStorageKeys();
    } catch {
      throw new DocumentServiceError("PERSISTENCE_UNAVAILABLE");
    }
    let files: Array<{ key: string; modifiedAt: Date }>;
    try {
      files = await this.storage.list();
    } catch {
      throw new DocumentServiceError("DOCUMENT_STORAGE_UNAVAILABLE");
    }
    const activeKeySet = new Set(activeKeys);
    const orphanCutoff = this.now().getTime() - 24 * 60 * 60 * 1_000;
    for (const file of files) {
      if (activeKeySet.has(file.key) || file.modifiedAt.getTime() > orphanCutoff) continue;
      try {
        await this.storage.delete(file.key);
      } catch {
        // Keep the orphan for a later private-storage cleanup pass.
      }
    }
    return deletedCount;
  }

  private async deleteQuietly(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch {
      // The periodic private-storage reconciliation retries orphan cleanup.
    }
  }
}
