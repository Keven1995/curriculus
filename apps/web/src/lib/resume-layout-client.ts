export type ResumeLayoutTemplate = {
  schemaVersion: "2.0";
  id: "sidebar-dark-header-color-v1";
  page: { format: "A4"; widthPt: number; heightPt: number; marginPt: number };
  palette: { sidebar: string; main: "#FFFFFF"; headerApprox: string; text: "#111111" };
  columns: { sidebarWidthPt: number; gapPt: number; sidebarRepeats: true };
  header: { heightPt: number; nameUppercase: true };
  typography: { namePt: number; sectionPt: number; bodyPt: number };
  sections: string[];
  sidebarSections: string[];
  overflow: { wrapText: true; pageBreak: true; keepExperienceHeadingWithFirstBullet: true };
  detection: { confidence: number; detectedColumns: 1 | 2; warnings: string[] };
};

export type ResumeLayoutImportResponse = {
  templateId: string;
  template: ResumeLayoutTemplate;
  detectedSections: Array<{ label: string; pageNumber: number; confidence: number }>;
  expiresAt: string;
};

type RequestOptions = { apiBaseUrl?: string; fetcher?: typeof fetch };

export class ResumeLayoutClientError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ResumeLayoutClientError";
  }
}

const messages: Record<string, string> = {
  FEATURE_NOT_AVAILABLE: "A importação de layout está habilitada somente no ambiente de teste local.",
  INVALID_PDF: "O PDF está inválido ou corrompido. Confira o arquivo e tente novamente.",
  FILE_TOO_LARGE: "O PDF deve ter no máximo 10 MiB.",
  TOO_MANY_PAGES: "O PDF deve ter no máximo 30 páginas.",
  NO_SELECTABLE_TEXT: "Este PDF parece digitalizado. O OCR não está habilitado; use um PDF com texto selecionável.",
  TEXT_TOO_LONG: "O texto do PDF excede o limite de extração.",
  ENCRYPTED_PDF: "PDFs protegidos por senha não são compatíveis.",
  PROCESSING_TIMEOUT: "A leitura demorou mais que o limite permitido. Tente um PDF menor ou mais simples.",
  TEMPLATE_EXPIRED: "A importação expirou. Envie o PDF de referência novamente.",
  RATE_LIMITED: "Muitas tentativas. Aguarde um pouco antes de continuar.",
  PAYLOAD_TOO_LARGE: "Os dados enviados excedem o limite permitido.",
  NETWORK_ERROR: "Não foi possível conectar ao serviço local. Verifique se `npm run dev:local-test` está em execução.",
  INVALID_RESPONSE: "O serviço local retornou uma resposta inválida.",
};

function apiUrl(options: RequestOptions): string {
  return (options.apiBaseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
}

async function safeJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return undefined;
  return error.code;
}

function throwApiError(payload: unknown, fallback = "INVALID_RESPONSE"): never {
  const code = errorCode(payload) ?? fallback;
  throw new ResumeLayoutClientError(messages[code] ?? "Não foi possível processar este currículo no modo local.", code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validImportResponse(value: unknown): value is ResumeLayoutImportResponse {
  if (!isRecord(value) || !isRecord(value.template)) return false;
  return typeof value.templateId === "string" && value.templateId.length > 0 && value.template.id === "sidebar-dark-header-color-v1" &&
    Array.isArray(value.detectedSections) && typeof value.expiresAt === "string" && !Number.isNaN(Date.parse(value.expiresAt));
}

export async function isResumeLayoutFeatureEnabled(options: RequestOptions = {}): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${apiUrl(options)}/features`, { method: "GET", cache: "no-store" });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const payload = await safeJson(response);
  return isRecord(payload) && payload.resumeLayoutImport === true;
}

export async function importReferencePdf(file: File, options: RequestOptions = {}): Promise<ResumeLayoutImportResponse> {
  if (!file.name.toLowerCase().endsWith(".pdf") || (file.type && file.type.toLowerCase() !== "application/pdf" && file.type.toLowerCase() !== "application/x-pdf")) {
    throw new ResumeLayoutClientError("Selecione um arquivo PDF.", "UNSUPPORTED_FILE");
  }
  if (file.size > 10 * 1024 * 1024) throw new ResumeLayoutClientError("O PDF deve ter no máximo 10 MiB.", "FILE_TOO_LARGE");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
    throw new ResumeLayoutClientError(messages.INVALID_PDF!, "INVALID_PDF");
  }

  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${apiUrl(options)}/resume-layouts/import`, {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: bytes,
    });
  } catch {
    throw new ResumeLayoutClientError(messages.NETWORK_ERROR!, "NETWORK_ERROR");
  }
  const payload = await safeJson(response);
  if (!response.ok) throwApiError(payload, "INVALID_PDF");
  if (!validImportResponse(payload)) throwApiError(payload);
  return payload;
}

export async function deleteImportedLayout(templateId: string, options: RequestOptions = {}): Promise<void> {
  if (!templateId.trim()) return;
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${apiUrl(options)}/resume-layouts/${encodeURIComponent(templateId)}`, { method: "DELETE" });
  } catch {
    throw new ResumeLayoutClientError(messages.NETWORK_ERROR!, "NETWORK_ERROR");
  }
  if (!response.ok) throwApiError(await safeJson(response));
}
