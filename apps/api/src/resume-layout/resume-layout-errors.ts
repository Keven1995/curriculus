export type ResumeLayoutErrorCode =
  | "invalid_pdf"
  | "file_too_large"
  | "too_many_pages"
  | "no_selectable_text"
  | "text_too_long"
  | "encrypted_pdf"
  | "template_expired"
  | "processing_timeout"
  | "render_failed";

export class ResumeLayoutError extends Error {
  constructor(readonly code: ResumeLayoutErrorCode) {
    super(code);
    this.name = "ResumeLayoutError";
  }
}
