import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { RESUME_LAYOUT_LIMITS, type ResumeLayoutImportResponse, type ResumeLayoutTemplate } from "./resume-layout-types.js";
import { extractPdfLayout } from "./pdf-layout-extractor.js";
import { ResumeLayoutError } from "./resume-layout-errors.js";

type CachedTemplate = {
  response: ResumeLayoutImportResponse;
  fileHash: string;
  expiresAtMs: number;
};

export class ResumeLayoutService {
  private readonly byId = new Map<string, CachedTemplate>();
  private readonly idByHash = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  private cleanExpired(): void {
    for (const [id, template] of this.byId) {
      if (template.expiresAtMs <= this.now()) {
        this.byId.delete(id);
        if (this.idByHash.get(template.fileHash) === id) this.idByHash.delete(template.fileHash);
      }
    }
  }

  cleanupExpired(): void {
    this.cleanExpired();
  }

  deleteTemplate(templateId: string): boolean {
    const cached = this.byId.get(templateId);
    if (!cached) return false;
    this.byId.delete(templateId);
    if (this.idByHash.get(cached.fileHash) === templateId) this.idByHash.delete(cached.fileHash);
    return true;
  }

  getTemplate(templateId: string): ResumeLayoutTemplate | undefined {
    this.cleanExpired();
    const cached = this.byId.get(templateId);
    if (!cached || cached.expiresAtMs <= this.now()) return undefined;
    return structuredClone(cached.response.template);
  }

  discardTextExtraction(templateId: string): void {
    const cached = this.byId.get(templateId);
    if (!cached) return;
    cached.response.rawExtraction = {
      ...cached.response.rawExtraction,
      source_file: { name: "referencia.pdf", size_bytes: 0 },
      pages: cached.response.rawExtraction.pages.map((page) => ({ ...page, text_blocks: [] })),
      usage: {
        ...cached.response.rawExtraction.usage,
        note: "O texto da extração foi descartado após associar o template visual à sessão.",
      },
    };
  }

  async importPdf(bytes: Buffer, fileName: string): Promise<ResumeLayoutImportResponse> {
    this.cleanExpired();
    if (bytes.length > RESUME_LAYOUT_LIMITS.maximumPdfBytes) throw new ResumeLayoutError("file_too_large");
    if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
      throw new ResumeLayoutError("invalid_pdf");
    }
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const existingId = this.idByHash.get(fileHash);
    const existing = existingId ? this.byId.get(existingId) : undefined;
    if (existing && existing.expiresAtMs > this.now()) return existing.response;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let extracted;
    try {
      extracted = await extractPdfLayout(bytes, fileName, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    while (this.byId.size >= 100) {
      const oldest = this.byId.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.byId.get(oldest);
      this.byId.delete(oldest);
      if (removed && this.idByHash.get(removed.fileHash) === oldest) this.idByHash.delete(removed.fileHash);
    }

    const expiresAtMs = this.now() + RESUME_LAYOUT_LIMITS.templateLifetimeMs;
    const response: ResumeLayoutImportResponse = {
      templateId: randomUUID(),
      template: extracted.template,
      rawExtraction: extracted.rawExtraction,
      detectedSections: extracted.detectedSections,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.byId.set(response.templateId, { response, fileHash, expiresAtMs });
    this.idByHash.set(fileHash, response.templateId);
    return response;
  }

  clear(): void {
    this.byId.clear();
    this.idByHash.clear();
  }
}
