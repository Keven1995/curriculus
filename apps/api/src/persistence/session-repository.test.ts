import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresSessionRepository,
  type Database,
  type QueryResult,
} from "./session-repository.js";

class FakeDatabase implements Database {
  calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  result: QueryResult<Record<string, unknown>> = { rows: [], rowCount: 0 };
  failure?: Error;

  async query<Row extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql, values });
    if (this.failure) throw this.failure;
    return this.result as QueryResult<Row>;
  }
}

const analysis = {
  jobRequirements: [],
  suggestions: [],
  documentStructure: { sectionOrder: [], suggestionOrder: [] },
};

const usage = {
  inputTokens: 321,
  outputTokens: 654,
  totalTokens: 975,
  estimatedCostUsd: 0.001,
};

test("reports unavailable schema without leaking database errors", async () => {
  const database = new FakeDatabase();
  database.failure = new Error("database connection details");
  const repository = new PostgresSessionRepository(database);

  assert.equal(await repository.isReady(), false);
  assert.match(database.calls[0]!.sql, /SELECT id FROM analysis_sessions LIMIT 0/);
});

test("creates a temporary analysis session with a database-generated expiration", async () => {
  const database = new FakeDatabase();
  database.result = {
    rows: [
      {
        id: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        expires_at: new Date("2026-01-02T00:00:00.000Z"),
      },
    ],
    rowCount: 1,
  };
  const repository = new PostgresSessionRepository(database);

  const session = await repository.createSession({
    jobUrl: "https://example.com/job",
    jobDescription: "Vaga de exemplo",
    resume: "Currículo de teste",
    analysis,
    usage,
  });

  assert.equal(session.id, "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea");
  assert.equal(session.expiresAt.toISOString(), "2026-01-02T00:00:00.000Z");
  assert.match(database.calls[0]!.sql, /INSERT INTO analysis_sessions/);
  assert.match(database.calls[0]!.sql, /INTERVAL '24 hours'/);
  assert.equal(database.calls[0]!.values[2], "Currículo de teste");
  assert.equal(database.calls[0]!.values[3], JSON.stringify(analysis));
});

test("loads only active analysis sessions", async () => {
  const database = new FakeDatabase();
  database.result = {
    rows: [
      {
        id: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
        status: "analysis_ready",
        job_url: null,
        job_description: "Vaga de exemplo",
        resume: "Currículo de teste",
        analysis_result: analysis,
        input_tokens: 321,
        output_tokens: 654,
        estimated_cost_usd: "0.001",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        expires_at: new Date("2026-01-02T00:00:00.000Z"),
      },
    ],
    rowCount: 1,
  };
  const repository = new PostgresSessionRepository(database);

  const session = await repository.findActiveSession("4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea");

  assert.equal(session?.resume, "Currículo de teste");
  assert.match(database.calls[0]!.sql, /expires_at > NOW\(\)/);
  assert.equal(database.calls[0]!.values[0], "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea");
});

test("deletes expired session rows and detaches their financial orders", async () => {
  const database = new FakeDatabase();
  database.result = { rows: [], rowCount: 3 };
  const repository = new PostgresSessionRepository(database);

  const deletedCount = await repository.deleteExpiredSessions();

  assert.equal(deletedCount, 3);
  assert.match(database.calls[0]!.sql, /DELETE FROM analysis_sessions/);
  assert.match(database.calls[0]!.sql, /status = 'analysis_ready'/);
  assert.match(database.calls[0]!.sql, /expires_at <= NOW\(\)/);
});

test("retains expired document keys until storage cleanup confirms deletion", async () => {
  const database = new FakeDatabase();
  const expiresAt = new Date("2026-01-03T00:00:00.000Z");
  database.result = {
    rows: [
      {
        id: "session-doc",
        document_storage_key: "private/document.pdf",
        expires_at: expiresAt,
      },
    ],
    rowCount: 1,
  };
  const repository = new PostgresSessionRepository(database);

  const expiredDocuments = await repository.findExpiredDocuments();
  assert.deepEqual(expiredDocuments, [
    { sessionId: "session-doc", storageKey: "private/document.pdf", expiresAt },
  ]);
  assert.match(database.calls[0]!.sql, /status = 'document_ready'/);

  database.result = { rows: [{ id: "session-doc" }], rowCount: 1 };
  assert.equal(await repository.deleteExpiredDocumentRecord("session-doc"), true);
  assert.match(database.calls[1]!.sql, /expires_at <= NOW\(\)/);
  assert.deepEqual(database.calls[1]!.values, ["session-doc"]);
});

test("clears source and analysis data after document creation and starts a 24h file expiry", async () => {
  const database = new FakeDatabase();
  database.result = { rows: [{ id: "session-1" }], rowCount: 1 };
  const repository = new PostgresSessionRepository(database);

  const updated = await repository.markDocumentGenerated("session-1", "private/key.pdf");

  assert.equal(updated, true);
  assert.match(database.calls[0]!.sql, /job_description = NULL/);
  assert.match(database.calls[0]!.sql, /resume = NULL/);
  assert.match(database.calls[0]!.sql, /analysis_result = NULL/);
  assert.match(database.calls[0]!.sql, /INTERVAL '24 hours'/);
  assert.match(database.calls[0]!.sql, /orders\.status = 'approved'/);
  assert.deepEqual(database.calls[0]!.values, ["session-1", "private/key.pdf"]);
});

test("creates pending orders with the product's fixed price and without resume data", async () => {
  const database = new FakeDatabase();
  database.result = {
    rows: [
      {
        id: "order-1",
        session_id: "session-1",
        amount_cents: 199,
        currency: "BRL",
        status: "pending",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        updated_at: new Date("2026-01-01T00:00:00.000Z"),
        checkout_expires_at: new Date("2026-01-02T00:00:00.000Z"),
      },
    ],
    rowCount: 1,
  };
  const repository = new PostgresSessionRepository(database);

  const order = await repository.createPendingOrder("session-1");

  assert.equal(order?.amountCents, 199);
  assert.equal(order?.currency, "BRL");
  assert.equal(order?.status, "pending");
  assert.match(database.calls[0]!.sql, /INSERT INTO orders/);
  assert.match(database.calls[0]!.sql, /'BRL'/);
  assert.deepEqual(database.calls[0]!.values, ["session-1"]);
  assert.equal(database.calls[0]!.sql.includes("resume"), false);
});

test("creates the required Neon schema and foreign-key retention behavior", async () => {
  const migration = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../../migrations/001_temporary_sessions.sql", import.meta.url), "utf8"),
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS analysis_sessions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS orders/);
  assert.match(migration, /ON DELETE SET NULL/);
  assert.match(migration, /expires_at/);
  assert.match(migration, /CHECK \(amount_cents = 199\)/);
});
