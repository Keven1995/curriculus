import { randomUUID } from "node:crypto";
import { RESUME_LAYOUT_LIMITS, type ResumeLayoutImportResponse } from "./resume-layout-types.js";
import type { ResumeLayoutTemplateStore } from "./resume-layout-store.js";
import { extractPdfLayout } from "./pdf-layout-extractor.js";
import { ResumeLayoutError } from "./resume-layout-errors.js";

export class ResumeLayoutService {
  constructor(
    private readonly store: ResumeLayoutTemplateStore,
    private readonly now: () => number = Date.now,
  ) {}

  isBackedBy(store: ResumeLayoutTemplateStore): boolean {
    return this.store === store;
  }

  async getTemplate(templateId: string) {
    return this.store.findTemporaryResumeLayout(templateId);
  }

  async deleteTemplate(templateId: string): Promise<boolean> {
    return this.store.deleteTemporaryResumeLayout(templateId);
  }

  async importPdf(bytes: Buffer, fileName: string): Promise<ResumeLayoutImportResponse> {
    if (bytes.length > RESUME_LAYOUT_LIMITS.maximumPdfBytes) throw new ResumeLayoutError("file_too_large");
    if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
      throw new ResumeLayoutError("invalid_pdf");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let extracted;
    try {
      extracted = await extractPdfLayout(bytes, fileName, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    const templateId = randomUUID();
    const expiresAt = extracted.layoutAvailable
      ? await this.store.storeTemporaryResumeLayout(templateId, extracted.template)
      : new Date(this.now() + RESUME_LAYOUT_LIMITS.templateLifetimeMs);

    return {
      templateId,
      template: extracted.template,
      resumeText: extracted.resumeText,
      layoutAvailable: extracted.layoutAvailable,
      layoutWarnings: extracted.layoutWarnings,
      rawExtraction: extracted.rawExtraction,
      detectedSections: extracted.detectedSections,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
