export type PixPaymentRequest = {
  payerEmail: string;
};

export type PixPaymentRequestIssue = {
  field: "payerEmail" | "_request";
  code: "required" | "invalid_type" | "invalid_email" | "too_long" | "unknown_field";
};

export type PixPaymentRequestValidation =
  | { success: true; data: PixPaymentRequest }
  | { success: false; issues: PixPaymentRequestIssue[] };

const MAX_EMAIL_LENGTH = 254;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePixPaymentRequest(input: unknown): PixPaymentRequestValidation {
  if (!isRecord(input)) {
    return { success: false, issues: [{ field: "_request", code: "invalid_type" }] };
  }

  const issues: PixPaymentRequestIssue[] = [];
  for (const field of Object.keys(input)) {
    if (field !== "payerEmail") issues.push({ field: "_request", code: "unknown_field" });
  }

  if (typeof input.payerEmail !== "string") {
    issues.push({ field: "payerEmail", code: input.payerEmail === undefined ? "required" : "invalid_type" });
  } else {
    const payerEmail = input.payerEmail.trim();
    if (!payerEmail) {
      issues.push({ field: "payerEmail", code: "required" });
    } else if (Array.from(payerEmail).length > MAX_EMAIL_LENGTH) {
      issues.push({ field: "payerEmail", code: "too_long" });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
      issues.push({ field: "payerEmail", code: "invalid_email" });
    } else {
      if (issues.length > 0) return { success: false, issues };
      return { success: true, data: { payerEmail } };
    }
  }

  return { success: false, issues };
}
