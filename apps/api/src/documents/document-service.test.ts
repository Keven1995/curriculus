import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisOutput } from "../analyses/analysis-output.js";
import type {
  OrderRecord,
  StoredAnalysisSession,
} from "../persistence/session-repository.js";
import type { ResumeLayoutTemplate } from "../resume-layout/resume-layout-types.js";
import { fileURLToPath } from "node:url";
import {
  DocumentService,
  DocumentServiceError,
  type DocumentRepository,
  type PrivateDocumentStorage,
} from "./document-service.js";

const sessionId = "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea";
const now = new Date("2026-01-01T00:00:00.000Z");
const analysis: AnalysisOutput = {
  jobRequirements: [],
  suggestions: [
    {
      id: "suggestion-1",
      category: "job_alignment",
      section: "Experiência",
      originalText: "Criei APIs.",
      suggestedText: "Desenvolvi APIs REST.",
      relatedRequirementIds: [],
      rationale: "Mantém o fato de origem.",
      sourceFacts: ["Criei APIs."],
      pointsToConfirm: [],
      sourceRange: { start: 0, end: 11 },
    },
  ],
  documentStructure: { sectionOrder: ["Experiência"], suggestionOrder: ["suggestion-1"] },
};

function makeSession(): StoredAnalysisSession {
  return {
    id: sessionId,
    status: "analysis_ready",
    jobDescription: "Vaga de desenvolvimento",
    resume: "Criei APIs.\nMantive sistemas.",
    analysis,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: null },
    createdAt: now,
    expiresAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function makeOrder(status: OrderRecord["status"] = "approved"): OrderRecord {
  return {
    id: "order-1",
    sessionId,
    amountCents: 199,
    currency: "BRL",
    status,
    providerPaymentId: "mp-payment-1",
    pixQrCode: "pix",
    pixQrCodeBase64: "base64",
    createdAt: now,
    updatedAt: now,
    checkoutExpiresAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

const referenceLayout: ResumeLayoutTemplate = {
  schemaVersion: "2.0",
  id: "sidebar-dark-header-color-v1",
  page: { format: "A4", widthPt: 595.28, heightPt: 841.89, marginPt: 30 },
  palette: { sidebar: "#354550", main: "#FFFFFF", headerApprox: "#BACD9E", text: "#111111" },
  columns: { sidebarWidthPt: 170, gapPt: 20, sidebarRepeats: true },
  header: { heightPt: 140, nameUppercase: true },
  typography: { namePt: 26, sectionPt: 14, bodyPt: 10.5 },
  sections: ["summary", "experience", "education", "certifications"],
  sidebarSections: ["photo", "contact", "skills"],
  overflow: { wrapText: true, pageBreak: true, keepExperienceHeadingWithFirstBullet: true },
  detection: { confidence: 0.55, detectedColumns: 2, warnings: [] },
};

class MemoryRepository implements DocumentRepository {
  ready = true;
  session: StoredAnalysisSession | null = makeSession();
  order: OrderRecord | null = makeOrder();
  generated: { sessionId: string; storageKey: string; expiresAt: Date } | null = null;
  expired: Array<{ sessionId: string; storageKey: string; expiresAt: Date }> = [];
  activeDocumentKeys: string[] = [];
  deletedRecords: string[] = [];

  async isReady() { return this.ready; }
  async findActiveSession(id: string) { return id === sessionId ? this.session : null; }
  async findOrderBySessionId(id: string) { return id === sessionId ? this.order : null; }
  async findGeneratedDocument(id: string) {
    return this.generated?.sessionId === id ? this.generated : null;
  }
  async findActiveDocumentStorageKeys() { return this.activeDocumentKeys; }
  async markDocumentGenerated(id: string, storageKey: string) {
    if (id !== sessionId || this.order?.status !== "approved" || !this.session) return false;
    this.generated = {
      sessionId: id,
      storageKey,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    };
    this.session = null;
    return true;
  }
  async findExpiredDocuments() { return this.expired; }
  async deleteExpiredDocumentRecord(id: string) {
    this.deletedRecords.push(id);
    this.expired = this.expired.filter((document) => document.sessionId !== id);
    return true;
  }
}

class MemoryStorage implements PrivateDocumentStorage {
  files = new Map<string, Buffer>();
  modifiedAt = new Map<string, Date>();
  writes: Array<{ key: string; contents: Buffer }> = [];
  deletes: string[] = [];

  async write(key: string, contents: Buffer) {
    this.files.set(key, contents);
    this.modifiedAt.set(key, now);
    this.writes.push({ key, contents });
  }
  async read(key: string) { return this.files.get(key) ?? null; }
  async list() {
    return [...this.files.keys()].map((key) => ({ key, modifiedAt: this.modifiedAt.get(key) ?? now }));
  }
  async delete(key: string) {
    this.deletes.push(key);
    this.files.delete(key);
    this.modifiedAt.delete(key);
  }
}

function createService(repository: MemoryRepository, storage: MemoryStorage, rendered: string[] = []) {
  return new DocumentService(
    repository,
    storage,
    "a-private-test-secret-with-at-least-32-characters",
    async (resume) => {
      rendered.push(resume);
      return Buffer.from(`PDF:${resume}`);
    },
    () => now,
  );
}

test("generates a private PDF from stored source text and only the approved suggestions", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  const rendered: string[] = [];
  const service = createService(repository, storage, rendered);

  const result = await service.generateDocument(sessionId, ["suggestion-1"]);

  assert.equal(result.format, "pdf");
  assert.equal(result.created, true);
  assert.equal(result.expiresAt.toISOString(), "2026-01-02T00:00:00.000Z");
  assert.match(result.downloadPath, /^\/documents\/[0-9a-f-]+\?token=/);
  assert.deepEqual(rendered, ["Desenvolvi APIs REST.\nMantive sistemas."]);
  assert.equal(storage.writes.length, 1);
  assert.equal(repository.session, null);
  assert.equal(repository.generated?.storageKey, storage.writes[0]?.key);
});

test("generates the approved revised text with the same imported two-column visual template", async () => {
  const repository = new MemoryRepository();
  repository.session = { ...makeSession(), resumeLayoutTemplate: referenceLayout };
  const storage = new MemoryStorage();
  const service = new DocumentService(
    repository,
    storage,
    "a-private-test-secret-with-at-least-32-characters",
    undefined,
    () => now,
  );

  const result = await service.generateDocument(sessionId, ["suggestion-1"]);
  const pdf = storage.files.get(repository.generated!.storageKey)!;
  assert.equal(result.created, true);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = fileURLToPath(new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));
  const parsed = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, standardFontDataUrl }).promise;
  try {
    assert.ok(parsed.numPages >= 1);
    let generatedText = "";
    for (let pageNumber = 1; pageNumber <= parsed.numPages; pageNumber += 1) {
      const page = await parsed.getPage(pageNumber);
      const content = await page.getTextContent();
      generatedText += content.items.map((item) => "str" in item ? item.str : "").join(" ");
    }
    assert.match(generatedText, /DESENVOLVI APIs REST/i);
    assert.match(generatedText, /Mantive sistemas/);
    assert.doesNotMatch(generatedText, /Criei APIs/);
  } finally {
    await parsed.destroy();
  }
});

test("does not generate or retain a document before server-side payment approval", async () => {
  const repository = new MemoryRepository();
  repository.order = makeOrder("pending");
  const storage = new MemoryStorage();
  const rendered: string[] = [];
  const service = createService(repository, storage, rendered);

  await assert.rejects(
    service.generateDocument(sessionId, ["suggestion-1"]),
    (error: Error) => error instanceof DocumentServiceError && error.code === "PAYMENT_NOT_APPROVED",
  );
  assert.equal(rendered.length, 0);
  assert.equal(storage.writes.length, 0);
  assert.ok(repository.session);
});

test("rejects client-selected IDs that are not part of the stored analysis", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  const service = createService(repository, storage);

  await assert.rejects(
    service.generateDocument(sessionId, ["client-invented-suggestion"]),
    (error: Error) => error instanceof DocumentServiceError && error.code === "INVALID_APPROVED_SUGGESTIONS",
  );
  assert.equal(storage.writes.length, 0);
  assert.ok(repository.session);
});

test("keeps source data and does not create a document when PDF rendering fails", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  const service = new DocumentService(
    repository,
    storage,
    "a-private-test-secret-with-at-least-32-characters",
    async () => { throw new Error("renderer internals"); },
    () => now,
  );

  await assert.rejects(
    service.generateDocument(sessionId, []),
    (error: Error) => error instanceof DocumentServiceError && error.code === "DOCUMENT_RENDER_FAILED",
  );
  assert.equal(storage.writes.length, 0);
  assert.ok(repository.session);
});

test("attempts to remove a partial private file when storage writing fails", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  storage.write = async (key, contents) => {
    storage.files.set(key, contents);
    storage.modifiedAt.set(key, now);
    throw new Error("disk full after partial write");
  };
  const service = createService(repository, storage);

  await assert.rejects(
    service.generateDocument(sessionId, []),
    (error: Error) => error instanceof DocumentServiceError && error.code === "DOCUMENT_STORAGE_UNAVAILABLE",
  );
  assert.equal(storage.files.size, 0);
  assert.equal(storage.deletes.length, 1);
  assert.ok(repository.session);
});

test("returns an expiring download only for a valid capability and stored document", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  const service = createService(repository, storage);
  const created = await service.generateDocument(sessionId, []);
  const token = new URL(created.downloadPath, "https://curriculus.example").searchParams.get("token");

  assert.ok(token);
  assert.deepEqual(await service.downloadDocument(sessionId, token), Buffer.from("PDF:Criei APIs.\nMantive sistemas."));
  await assert.rejects(
    service.downloadDocument(sessionId, `${token}tampered`),
    (error: Error) => error instanceof DocumentServiceError && error.code === "DOCUMENT_NOT_AVAILABLE",
  );
});

test("returns the same existing document on retries instead of generating a second PDF", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  const rendered: string[] = [];
  const service = createService(repository, storage, rendered);

  const first = await service.generateDocument(sessionId, ["suggestion-1"]);
  const retry = await service.generateDocument(sessionId, []);

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.downloadPath, first.downloadPath);
  assert.equal(storage.writes.length, 1);
  assert.equal(rendered.length, 1);
});

test("deletes expired files before removing their database references", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  storage.files.set("expired.pdf", Buffer.from("private"));
  repository.expired = [{ sessionId, storageKey: "expired.pdf", expiresAt: now }];
  const service = createService(repository, storage);

  assert.equal(await service.deleteExpiredDocuments(), 1);
  assert.deepEqual(storage.deletes, ["expired.pdf"]);
  assert.deepEqual(repository.deletedRecords, [sessionId]);
});

test("keeps the database reference when deleting an expired file fails so cleanup can retry", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  storage.delete = async () => { throw new Error("storage unavailable"); };
  repository.expired = [{ sessionId, storageKey: "expired.pdf", expiresAt: now }];
  const service = createService(repository, storage);

  assert.equal(await service.deleteExpiredDocuments(), 0);
  assert.deepEqual(repository.deletedRecords, []);
  assert.equal(repository.expired.length, 1);
});

test("sweeps only unreferenced orphan PDFs older than the retention window", async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryStorage();
  const orphanKey = "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea.pdf";
  const activeKey = "5e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea.pdf";
  storage.files.set(orphanKey, Buffer.from("orphan"));
  storage.modifiedAt.set(orphanKey, new Date(now.getTime() - 25 * 60 * 60 * 1_000));
  storage.files.set(activeKey, Buffer.from("active"));
  storage.modifiedAt.set(activeKey, new Date(now.getTime() - 25 * 60 * 60 * 1_000));
  repository.activeDocumentKeys = [activeKey];
  const service = createService(repository, storage);

  await service.deleteExpiredDocuments();

  assert.equal(storage.files.has(orphanKey), false);
  assert.equal(storage.files.has(activeKey), true);
});
