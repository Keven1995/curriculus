import type { AnalysisOutput } from "../analyses/analysis-output.js";
import type { AnalysisRequest } from "../analyses/analysis-request.js";
import type { AnalysisUsage } from "../analyses/analysis-service.js";

export type QueryResult<Row extends Record<string, unknown>> = {
  rows: Row[];
  rowCount: number;
};

export interface Database {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  close?(): Promise<void>;
}

export type CreateAnalysisSession = {
  jobUrl?: string;
  jobDescription: string;
  resume: string;
  analysis: AnalysisOutput;
  usage: AnalysisUsage;
};

export type SessionReference = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
};

export type ExpiredDocumentReference = {
  sessionId: string;
  storageKey: string;
  expiresAt: Date;
};

export type StoredAnalysisSession = CreateAnalysisSession & SessionReference & {
  status: "analysis_ready";
};

export type OrderStatus = "pending" | "approved" | "rejected" | "expired" | "refunded";

export type OrderRecord = {
  id: string;
  sessionId: string | null;
  amountCents: 199;
  currency: "BRL";
  status: OrderStatus;
  providerPaymentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  checkoutExpiresAt: Date;
};

export interface SessionRepository {
  isReady(): Promise<boolean>;
  createSession(input: CreateAnalysisSession): Promise<SessionReference>;
  findActiveSession(id: string): Promise<StoredAnalysisSession | null>;
  deleteExpiredSessions(): Promise<number>;
  findExpiredDocuments(): Promise<ExpiredDocumentReference[]>;
  deleteExpiredDocumentRecord(id: string): Promise<boolean>;
  markDocumentGenerated(id: string, storageKey: string): Promise<boolean>;
  createPendingOrder(sessionId: string): Promise<OrderRecord | null>;
  findOrder(id: string): Promise<OrderRecord | null>;
  close?(): Promise<void>;
}

type SessionRow = Record<string, unknown>;

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Invalid database timestamp.");
  return date;
}

function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid numeric database value.");
  return number;
}

function asOrderStatus(value: unknown): OrderStatus {
  if (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "expired" ||
    value === "refunded"
  ) {
    return value;
  }
  throw new Error("Invalid database order status.");
}

function mapOrder(row: SessionRow): OrderRecord {
  if (row.currency !== "BRL" || Number(row.amount_cents) !== 199) {
    throw new Error("Invalid database order amount.");
  }

  return {
    id: String(row.id),
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
    amountCents: 199,
    currency: "BRL",
    status: asOrderStatus(row.status),
    providerPaymentId:
      typeof row.provider_payment_id === "string" ? row.provider_payment_id : null,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    checkoutExpiresAt: asDate(row.checkout_expires_at),
  };
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly database: Database) {}

  async isReady(): Promise<boolean> {
    try {
      await this.database.query<SessionRow>(
        "SELECT id FROM analysis_sessions LIMIT 0",
      );
      return true;
    } catch {
      return false;
    }
  }

  async createSession(input: CreateAnalysisSession): Promise<SessionReference> {
    const result = await this.database.query<SessionRow>(
      `INSERT INTO analysis_sessions (
         job_url,
         job_description,
         resume,
         analysis_result,
         input_tokens,
         output_tokens,
         estimated_cost_usd,
         expires_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW() + INTERVAL '24 hours')
       RETURNING id, created_at, expires_at`,
      [
        input.jobUrl ?? null,
        input.jobDescription,
        input.resume,
        JSON.stringify(input.analysis),
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.estimatedCostUsd,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Could not persist analysis session.");

    return {
      id: String(row.id),
      createdAt: asDate(row.created_at),
      expiresAt: asDate(row.expires_at),
    };
  }

  async findActiveSession(id: string): Promise<StoredAnalysisSession | null> {
    const result = await this.database.query<SessionRow>(
      `SELECT id, status, job_url, job_description, resume, analysis_result,
              input_tokens, output_tokens, estimated_cost_usd, created_at, expires_at
         FROM analysis_sessions
        WHERE id = $1 AND status = 'analysis_ready' AND expires_at > NOW()`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;

    return {
      id: String(row.id),
      status: "analysis_ready",
      jobUrl: typeof row.job_url === "string" ? row.job_url : undefined,
      jobDescription: String(row.job_description),
      resume: String(row.resume),
      analysis: asJson<AnalysisOutput>(row.analysis_result),
      usage: {
        inputTokens: asNumber(row.input_tokens),
        outputTokens: asNumber(row.output_tokens),
        totalTokens: asNumber(row.input_tokens) + asNumber(row.output_tokens),
        estimatedCostUsd:
          row.estimated_cost_usd === null || row.estimated_cost_usd === undefined
            ? null
            : asNumber(row.estimated_cost_usd),
      },
      createdAt: asDate(row.created_at),
      expiresAt: asDate(row.expires_at),
    };
  }

  async deleteExpiredSessions(): Promise<number> {
    const result = await this.database.query<SessionRow>(
      `DELETE FROM analysis_sessions
        WHERE status = 'analysis_ready' AND expires_at <= NOW()
        RETURNING id`,
    );
    return result.rowCount;
  }

  async findExpiredDocuments(): Promise<ExpiredDocumentReference[]> {
    const result = await this.database.query<SessionRow>(
      `SELECT id, document_storage_key, expires_at
         FROM analysis_sessions
        WHERE status = 'document_ready' AND expires_at <= NOW()`,
    );

    return result.rows.map((row) => ({
      sessionId: String(row.id),
      storageKey: String(row.document_storage_key),
      expiresAt: asDate(row.expires_at),
    }));
  }

  async deleteExpiredDocumentRecord(id: string): Promise<boolean> {
    const result = await this.database.query<SessionRow>(
      `DELETE FROM analysis_sessions
        WHERE id = $1 AND status = 'document_ready' AND expires_at <= NOW()
        RETURNING id`,
      [id],
    );
    return result.rowCount > 0;
  }

  async markDocumentGenerated(id: string, storageKey: string): Promise<boolean> {
    if (!storageKey.trim()) throw new Error("A document storage key is required.");

    const result = await this.database.query<SessionRow>(
      `UPDATE analysis_sessions
          SET status = 'document_ready',
              job_url = NULL,
              job_description = NULL,
              resume = NULL,
              analysis_result = NULL,
              document_storage_key = $2,
              document_created_at = NOW(),
              expires_at = NOW() + INTERVAL '24 hours'
        WHERE id = $1 AND status = 'analysis_ready' AND expires_at > NOW()
          AND EXISTS (
            SELECT 1 FROM orders
             WHERE orders.session_id = analysis_sessions.id
               AND orders.status = 'approved'
          )
        RETURNING id`,
      [id, storageKey],
    );
    return result.rowCount > 0;
  }

  async createPendingOrder(sessionId: string): Promise<OrderRecord | null> {
    const result = await this.database.query<SessionRow>(
      `INSERT INTO orders (session_id, amount_cents, currency, status, checkout_expires_at)
       SELECT id, 199, 'BRL', 'pending', expires_at
         FROM analysis_sessions
        WHERE id = $1 AND status = 'analysis_ready' AND expires_at > NOW()
       RETURNING id, session_id, amount_cents, currency, status,
                 provider_payment_id, created_at, updated_at, checkout_expires_at`,
      [sessionId],
    );
    const row = result.rows[0];
    return row ? mapOrder(row) : null;
  }

  async findOrder(id: string): Promise<OrderRecord | null> {
    const result = await this.database.query<SessionRow>(
      `SELECT id, session_id, amount_cents, currency, status,
              provider_payment_id, created_at, updated_at, checkout_expires_at
         FROM orders WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapOrder(row) : null;
  }

  async close(): Promise<void> {
    await this.database.close?.();
  }
}
