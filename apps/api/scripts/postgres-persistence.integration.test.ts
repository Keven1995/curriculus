import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { config as loadDotEnv } from "dotenv";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { createConfiguredSessionRepository } from "../src/persistence/postgres-session-repository.js";
import type { CreateAnalysisSession } from "../src/persistence/session-repository.js";
import type { ResumeLayoutTemplate } from "../src/resume-layout/resume-layout-types.js";

loadDotEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env.postgres"),
  quiet: true,
});

const requiredMigrations = [
  "001_temporary_sessions.sql",
  "002_pix_payment_instructions.sql",
  "003_resume_layout_template.sql",
  "004_document_layout_fallback.sql",
  "005_temporary_resume_layouts.sql",
  "006_distributed_rate_limits.sql",
];

const analysisInput: Omit<CreateAnalysisSession, "resumeLayoutTemplate"> = {
  jobDescription: "Synthetic integration-test job description.",
  resume: "Synthetic integration-test resume; contains no personal data.",
  analysis: {
    jobRequirements: [],
    suggestions: [],
    documentStructure: { sectionOrder: [], suggestionOrder: [] },
  },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: null },
};

const templateV2: ResumeLayoutTemplate = {
  schemaVersion: "2.0",
  id: "sidebar-dark-header-color-v1",
  page: { format: "A4", widthPt: 595.28, heightPt: 841.89, marginPt: 30 },
  palette: { sidebar: "#354550", main: "#FFFFFF", headerApprox: "#BACD9E", text: "#111111" },
  columns: { sidebarWidthPt: 170, gapPt: 20, sidebarRepeats: true },
  header: { heightPt: 140, nameUppercase: true },
  typography: { namePt: 26, sectionPt: 14, bodyPt: 10.5 },
  sections: ["summary", "experience", "education"],
  sidebarSections: ["contact", "skills"],
  overflow: { wrapText: true, pageBreak: true, keepExperienceHeadingWithFirstBullet: true },
  detection: { confidence: 0.8, detectedColumns: 2, warnings: [] },
};

const templateV3: ResumeLayoutTemplate = {
  schemaVersion: "3.0",
  id: "adaptive-resume-layout-v1",
  page: { format: "A4", widthPt: 595.28, heightPt: 841.89, marginPt: 30 },
  palette: { sidebar: "#354550", main: "#FFFFFF", headerApprox: "#BACD9E", text: "#111111" },
  columns: {
    count: 1,
    sidebarWidthPt: 0,
    gapPt: 0,
    sidebarRepeats: false,
    sidebarSide: "left",
    sidebarXPt: 0,
    mainXPt: 30,
    mainWidthPt: 535.28,
  },
  header: {
    heightPt: 80,
    nameUppercase: false,
    nameAlignment: "left",
    nameTextColor: "#111111",
    nameRegion: "main",
    nameXPt: 30,
    nameYPt: 30,
  },
  typography: {
    namePt: 24,
    sectionPt: 14,
    bodyPt: 10,
    nameFont: "Helvetica",
    headingFont: "Helvetica",
    bodyFont: "Helvetica",
    nameWeight: "bold",
    headingWeight: "bold",
    bodyWeight: "normal",
  },
  visual: {
    contentBounds: { x: 30, y: 30, width: 535.28, height: 781.89 },
    regions: [],
    sectionPlacements: [],
    bodyTextColor: "#111111",
    headingTextColor: "#111111",
    bodyLineHeightRatio: 1.2,
    paragraphGapPt: 4,
    warnings: [],
  },
  sections: ["summary", "experience", "education"],
  sidebarSections: [],
  overflow: { wrapText: true, pageBreak: true, keepExperienceHeadingWithFirstBullet: true },
  detection: { confidence: 0.95, detectedColumns: 1, warnings: [] },
};

function localDatabaseUrl(): string {
  const connectionString = process.env.TEST_DATABASE_URL?.trim();
  assert.ok(connectionString, "Set TEST_DATABASE_URL in .env.postgres before running PostgreSQL integration tests.");

  const url = new URL(connectionString);
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname),
    "Refusing PostgreSQL integration tests unless the host is local.",
  );
  assert.equal(url.port || "5432", "5434", "Refusing PostgreSQL integration tests unless the port is 5434.");
  assert.equal(url.pathname, "/curriculus_local", "Refusing PostgreSQL integration tests unless the database is curriculus_local.");
  return connectionString;
}

function createRepository(connectionString: string) {
  const repository = createConfiguredSessionRepository({ DATABASE_URL: connectionString });
  assert.ok(repository);
  return repository;
}

function createRateLimitSecret(): string {
  return randomBytes(32).toString("hex");
}

type HttpProcessOptions = {
  connectionString: string;
  rateLimitHmacSecret: string;
  limit: number;
  windowMs: number;
  trustedProxyHops?: number;
  documentStorageDir?: string;
  documentDownloadSecret?: string;
  allowDatabaseFailure?: boolean;
};

async function startHttpProcess(options: HttpProcessOptions) {
  const workerPath = fileURLToPath(new URL("./postgres-http-worker.ts", import.meta.url));
  const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: options.connectionString,
    RATE_LIMIT_HMAC_SECRET: options.rateLimitHmacSecret,
    TRUST_PROXY_HOPS: String(options.trustedProxyHops ?? 0),
    CURRICULUS_RATE_LIMIT_TEST_LIMIT: String(options.limit),
    CURRICULUS_RATE_LIMIT_TEST_WINDOW_MS: String(options.windowMs),
  };
  if (options.documentStorageDir) environment.DOCUMENT_STORAGE_DIR = options.documentStorageDir;
  else delete environment.DOCUMENT_STORAGE_DIR;
  if (options.documentDownloadSecret) environment.DOCUMENT_DOWNLOAD_SECRET = options.documentDownloadSecret;
  else delete environment.DOCUMENT_DOWNLOAD_SECRET;
  if (options.allowDatabaseFailure) environment.CURRICULUS_TEST_ALLOW_DB_FAILURE = "true";
  else delete environment.CURRICULUS_TEST_ALLOW_DB_FAILURE;
  const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
    cwd: rootDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errorOutput = "";
  const baseUrl = await new Promise<string>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      child.kill();
      rejectReady(new Error(`Local API process did not become ready. ${errorOutput.slice(-300)}`));
    }, 15_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const ready = /^READY (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output);
      if (!ready) return;
      clearTimeout(timeout);
      resolveReady(ready[1]!);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput = `${errorOutput}${chunk.toString("utf8")}`.slice(-1_000);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Local API process exited before ready (${code ?? signal}). ${errorOutput.slice(-300)}`));
    });
  });
  const worker = child;
  let stopped = false;
  return {
    child: worker,
    baseUrl,
    async close() {
      if (stopped || worker.exitCode !== null || worker.signalCode !== null) return;
      stopped = true;
      const exited = new Promise<void>((resolveExit) => worker.once("exit", () => resolveExit()));
      worker.kill();
      await exited;
    },
  };
}

function clientDigest(secret: string, ip: string): string {
  return createHmac("sha256", secret).update(ip).digest("hex");
}

test("PostgreSQL migrations, persistence, expiration, atomic layout consumption and v2/v3 templates", async () => {
  const connectionString = localDatabaseUrl();
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 });
  const sessionIds: string[] = [];
  const orderIds: string[] = [];
  const temporaryLayoutIds: string[] = [];
  const rateLimitClientHashes = new Set<string>();
  const apiInstances: Array<Awaited<ReturnType<typeof startHttpProcess>>> = [];
  const extraRepositories: Array<ReturnType<typeof createRepository>> = [];
  const closedRepositories = new WeakSet<object>();
  const openRepository = () => {
    const next = createRepository(connectionString);
    extraRepositories.push(next);
    return next;
  };
  const closeRepository = async (target: ReturnType<typeof createRepository>) => {
    if (closedRepositories.has(target)) return;
    closedRepositories.add(target);
    await target.close();
  };
  let repository = openRepository();
  let secondRepository: ReturnType<typeof createRepository> | undefined;
  let temporaryStorageDirectory: string | undefined;

  try {
    const databaseIdentity = await pool.query<{
      current_database: string;
      server_address: string | null;
      server_port: number;
    }>("SELECT current_database(), inet_server_addr()::text AS server_address, inet_server_port() AS server_port");
    assert.equal(databaseIdentity.rows[0]?.current_database, "curriculus_local");
    assert.equal(databaseIdentity.rows[0]?.server_port, 5432, "localhost:5434 must terminate at the expected local PostgreSQL listener.");
    assert.ok(databaseIdentity.rows[0]?.server_address, "PostgreSQL must report a TCP server address.");

    const migrationRows = await pool.query<{ version: string }>(
      "SELECT version FROM curriculus_schema_migrations ORDER BY version",
    );
    const appliedMigrations = new Set(migrationRows.rows.map((row) => row.version));
    for (const migration of requiredMigrations) {
      assert.ok(appliedMigrations.has(migration), `Migration ${migration} has not been applied.`);
    }
    assert.equal(await repository.isReady(), true, "The migrated repository schema must be ready.");

    // Two independent HTTP servers and two independent PostgreSQL pools share one client bucket.
    const sharedSecret = createRateLimitSecret();
    const sharedClientHash = clientDigest(sharedSecret, "127.0.0.1");
    rateLimitClientHashes.add(sharedClientHash);
    const sharedApiA = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: sharedSecret, limit: 3, windowMs: 60_000,
    });
    const sharedApiB = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: sharedSecret, limit: 3, windowMs: 60_000,
    });
    apiInstances.push(sharedApiA, sharedApiB);

    const sharedStatuses = [
      (await fetch(new URL("/features", sharedApiA.baseUrl), { headers: { "x-forwarded-for": "203.0.113.99" } })).status,
      (await fetch(new URL("/features", sharedApiA.baseUrl))).status,
      (await fetch(new URL("/features", sharedApiB.baseUrl))).status,
      (await fetch(new URL("/features", sharedApiA.baseUrl))).status,
    ];
    assert.deepEqual(sharedStatuses, [200, 200, 200, 429], "the per-client limit must be shared across HTTP instances");
    const storedSharedBucket = await pool.query<{ client_hash: string; request_count: number }>(
      `SELECT client_hash::text AS client_hash, request_count
         FROM rate_limit_buckets WHERE scope = 'global' AND client_hash = $1 AND window_ms = $2`,
      [sharedClientHash, 60_000],
    );
    assert.equal(storedSharedBucket.rows[0]?.client_hash, sharedClientHash);
    assert.equal(storedSharedBucket.rows[0]?.request_count, 4, "blocked requests saturate at limit + 1");
    assert.equal(sharedClientHash.includes("127.0.0.1"), false);
    assert.equal(
      (await pool.query(
        "SELECT 1 FROM rate_limit_buckets WHERE client_hash::text = ANY($1::text[])",
        [["127.0.0.1", "203.0.113.99", "198.51.100.24"]],
      )).rowCount,
      0,
      "raw socket and forwarded IP addresses must not be persisted in the client hash column",
    );

    // Race requests across separate API and repository instances; exactly four can pass.
    const concurrentSecret = createRateLimitSecret();
    const concurrentClientHash = clientDigest(concurrentSecret, "127.0.0.1");
    rateLimitClientHashes.add(concurrentClientHash);
    const concurrentApiA = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: concurrentSecret, limit: 4, windowMs: 60_000,
    });
    const concurrentApiB = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: concurrentSecret, limit: 4, windowMs: 60_000,
    });
    apiInstances.push(concurrentApiA, concurrentApiB);
    const concurrentStatuses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => fetch(
        new URL("/features", index % 2 === 0 ? concurrentApiA.baseUrl : concurrentApiB.baseUrl),
      ).then((response) => response.status)),
    );
    assert.equal(concurrentStatuses.filter((status) => status === 200).length, 4);
    assert.equal(concurrentStatuses.filter((status) => status === 429).length, 8);

    // Verify a fixed-window reset without invoking global cleanup on unrelated buckets.
    const expirySecret = createRateLimitSecret();
    const expiryClientHash = clientDigest(expirySecret, "127.0.0.1");
    rateLimitClientHashes.add(expiryClientHash);
    const expiryApiA = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: expirySecret, limit: 1, windowMs: 5_000,
    });
    const expiryApiB = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: expirySecret, limit: 1, windowMs: 5_000,
    });
    apiInstances.push(expiryApiA, expiryApiB);
    const beforeWindowEnd = await pool.query<{ remaining_ms: number }>(
      `SELECT ceil(extract(epoch FROM (
         to_timestamp(floor(extract(epoch FROM clock_timestamp()) * 1000 / $1) * $1 / 1000.0)
         + ($1 * INTERVAL '1 millisecond') - clock_timestamp()
       )) * 1000)::integer AS remaining_ms`,
      [5_000],
    );
    const remainingMs = beforeWindowEnd.rows[0]?.remaining_ms ?? 0;
    if (remainingMs < 1_500) await new Promise((resolveDelay) => setTimeout(resolveDelay, remainingMs + 150));
    assert.equal((await fetch(new URL("/features", expiryApiA.baseUrl))).status, 200);
    assert.equal((await fetch(new URL("/features", expiryApiB.baseUrl))).status, 429);
    const expiryBucket = await pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM rate_limit_buckets
        WHERE scope = 'global' AND client_hash = $1 AND window_ms = $2
        ORDER BY window_started_at DESC LIMIT 1`,
      [expiryClientHash, 5_000],
    );
    const waitMs = (expiryBucket.rows[0]?.expires_at.getTime() ?? Date.now()) - Date.now() + 150;
    if (waitMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    assert.equal((await fetch(new URL("/features", expiryApiB.baseUrl))).status, 200, "a new DB window must accept the client again");

    // Proxy tests model the configured hop count; only the HMAC is stored, never either address.
    const trustedProxySecret = createRateLimitSecret();
    const forwardedIp = "198.51.100.24";
    const forwardedHash = clientDigest(trustedProxySecret, forwardedIp);
    rateLimitClientHashes.add(forwardedHash);
    const trustedProxyApi = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: trustedProxySecret, limit: 5, windowMs: 60_000, trustedProxyHops: 1,
    });
    apiInstances.push(trustedProxyApi);
    assert.equal((await fetch(new URL("/features", trustedProxyApi.baseUrl), {
      headers: { "x-forwarded-for": forwardedIp },
    })).status, 200);
    const forwardedBucket = await pool.query<{ client_hash: string }>(
      `SELECT client_hash::text AS client_hash FROM rate_limit_buckets
        WHERE scope = 'global' AND client_hash = $1 AND window_ms = $2`,
      [forwardedHash, 60_000],
    );
    assert.equal(forwardedBucket.rows[0]?.client_hash, forwardedHash);
    assert.notEqual(forwardedHash, forwardedIp);

    // A failed DB pool must reject protected requests while liveness stays independent.
    const failedStoreApi = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: createRateLimitSecret(), limit: 5, windowMs: 60_000,
      allowDatabaseFailure: true,
    });
    apiInstances.push(failedStoreApi);
    assert.equal((await fetch(new URL("/features", failedStoreApi.baseUrl))).status, 200);
    assert.equal((await fetch(new URL("/__test/close-database", failedStoreApi.baseUrl), { method: "POST" })).status, 204);
    const failedStoreResponse = await fetch(new URL("/features", failedStoreApi.baseUrl));
    assert.equal(failedStoreResponse.status, 503);
    assert.equal((await failedStoreResponse.json() as { error: { code: string } }).error.code, "RATE_LIMIT_UNAVAILABLE");
    assert.equal((await fetch(new URL("/health", failedStoreApi.baseUrl))).status, 200);
    assert.equal((await fetch(new URL("/ready", failedStoreApi.baseUrl))).status, 503);

    for (const instance of apiInstances) await instance.close();
    apiInstances.length = 0;

    for (const [version, template] of [["v2", templateV2], ["v3", templateV3]] as const) {
      const session = await repository.createSession({ ...analysisInput, resumeLayoutTemplate: template });
      sessionIds.push(session.id);
      await closeRepository(repository);
      repository = openRepository();

      const restoredSession = await repository.findActiveSession(session.id);
      assert.deepEqual(restoredSession?.resumeLayoutTemplate, template, `${version} template did not survive a repository restart.`);
    }

    const temporaryColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'temporary_resume_layouts'
        ORDER BY ordinal_position`,
    );
    assert.deepEqual(temporaryColumns.rows.map((row) => row.column_name), ["id", "template", "created_at", "expires_at"]);

    const expiredLayoutId = randomUUID();
    temporaryLayoutIds.push(expiredLayoutId);
    await repository.storeTemporaryResumeLayout(expiredLayoutId, templateV3);
    await pool.query(
      `UPDATE temporary_resume_layouts
          SET created_at = NOW() - INTERVAL '2 seconds',
              expires_at = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [expiredLayoutId],
    );
    assert.equal(await repository.findTemporaryResumeLayout(expiredLayoutId), null);
    assert.equal(await repository.deleteTemporaryResumeLayout(expiredLayoutId), true);

    const sharedLayoutId = randomUUID();
    temporaryLayoutIds.push(sharedLayoutId);
    await repository.storeTemporaryResumeLayout(sharedLayoutId, templateV2);
    secondRepository = createRepository(connectionString);
    const claims = await Promise.all([
      repository.createSessionWithTemporaryLayout(analysisInput, sharedLayoutId),
      secondRepository.createSessionWithTemporaryLayout(analysisInput, sharedLayoutId),
    ]);
    const successfulClaims = claims.filter((claim) => claim !== null);
    assert.equal(successfulClaims.length, 1, "A temporary layout must be consumed by at most one concurrent session.");
    sessionIds.push(successfulClaims[0]!.id);
    assert.equal(await repository.findTemporaryResumeLayout(sharedLayoutId), null);
    const claimedSession = await repository.findActiveSession(successfulClaims[0]!.id);
    assert.deepEqual(claimedSession?.resumeLayoutTemplate, templateV2);

    // Restart complete HTTP workers around persisted session, approved order and private PDF.
    const restartRepository = openRepository();
    const syntheticResume = "Synthetic restart-test resume: built sample APIs and documented fictional systems.";
    const restartSession = await restartRepository.createSession({
      ...analysisInput,
      resume: syntheticResume,
    });
    sessionIds.push(restartSession.id);
    const order = await restartRepository.createPendingOrder(restartSession.id);
    assert.ok(order);
    orderIds.push(order.id);
    const providerPaymentId = `synthetic-${randomUUID()}`;
    assert.equal(await restartRepository.attachProviderPaymentId(order.id, providerPaymentId), true);
    assert.equal(await restartRepository.updateOrderStatusByProviderPaymentId(providerPaymentId, "approved"), true);

    const restartRateLimitSecret = createRateLimitSecret();
    rateLimitClientHashes.add(clientDigest(restartRateLimitSecret, "127.0.0.1"));
    const beforeRestartApi = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: restartRateLimitSecret,
      limit: 100,
      windowMs: 60_000,
    });
    apiInstances.push(beforeRestartApi);
    const persistedPayment = await fetch(new URL(`/sessions/${restartSession.id}/payments/status`, beforeRestartApi.baseUrl));
    assert.equal(persistedPayment.status, 200);
    assert.deepEqual(await persistedPayment.json(), { status: "approved" });
    const readiness = await fetch(new URL("/ready", beforeRestartApi.baseUrl));
    assert.equal(readiness.status, 200);
    assert.deepEqual(await readiness.json(), { status: "ready" });
    await beforeRestartApi.close();
    await closeRepository(restartRepository);

    temporaryStorageDirectory = await mkdtemp(join(tmpdir(), "curriculus-pg-integration-"));
    const downloadSecret = createRateLimitSecret();
    const generatingApi = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: restartRateLimitSecret,
      limit: 100,
      windowMs: 60_000,
      documentStorageDir: temporaryStorageDirectory,
      documentDownloadSecret: downloadSecret,
    });
    apiInstances.push(generatingApi);
    const generation = await fetch(new URL(`/sessions/${restartSession.id}/documents`, generatingApi.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvedSuggestionIds: [], finalResumeText: syntheticResume }),
    });
    assert.equal(generation.status, 201);
    const generatedDocument = await generation.json() as { format: string; downloadPath: string };
    assert.equal(generatedDocument.format, "pdf");
    await generatingApi.close();

    const downloadingApi = await startHttpProcess({
      connectionString,
      rateLimitHmacSecret: restartRateLimitSecret,
      limit: 100,
      windowMs: 60_000,
      documentStorageDir: temporaryStorageDirectory,
      documentDownloadSecret: downloadSecret,
    });
    apiInstances.push(downloadingApi);
    const download = await fetch(new URL(generatedDocument.downloadPath, downloadingApi.baseUrl));
    assert.equal(download.status, 200, "private PDF must remain downloadable after restarting the HTTP process");
    const pdfContents = Buffer.from(await download.arrayBuffer());
    assert.equal(pdfContents.toString("ascii", 0, 5), "%PDF-");

    const repeatedGeneration = await fetch(new URL(`/sessions/${restartSession.id}/documents`, downloadingApi.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvedSuggestionIds: [], finalResumeText: syntheticResume }),
    });
    assert.equal(repeatedGeneration.status, 200, "retry after restart must reuse the existing document");
    const reusedDocument = await repeatedGeneration.json() as { downloadPath: string };
    assert.equal(reusedDocument.downloadPath, generatedDocument.downloadPath);
    assert.equal((await readdir(temporaryStorageDirectory)).filter((file) => file.endsWith(".pdf")).length, 1);
    const persistedDocument = await pool.query<{ status: string; document_storage_key: string | null }>(
      "SELECT status, document_storage_key FROM analysis_sessions WHERE id = $1",
      [restartSession.id],
    );
    assert.equal(persistedDocument.rowCount, 1);
    assert.equal(persistedDocument.rows[0]?.status, "document_ready");
    assert.ok(persistedDocument.rows[0]?.document_storage_key);
  } finally {
    for (const instance of apiInstances) await instance.close().catch(() => undefined);
    if (orderIds.length > 0) {
      await pool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orderIds]).catch(() => undefined);
    }
    if (sessionIds.length > 0) {
      await pool.query("DELETE FROM analysis_sessions WHERE id = ANY($1::uuid[])", [sessionIds]).catch(() => undefined);
    }
    if (temporaryLayoutIds.length > 0) {
      await pool.query("DELETE FROM temporary_resume_layouts WHERE id = ANY($1::uuid[])", [temporaryLayoutIds]).catch(() => undefined);
    }
    for (const clientHash of rateLimitClientHashes) {
      await pool.query(
        "DELETE FROM rate_limit_buckets WHERE scope = 'global' AND client_hash = $1",
        [clientHash],
      ).catch(() => undefined);
    }
    if (secondRepository) await closeRepository(secondRepository);
    for (const testRepository of extraRepositories) await closeRepository(testRepository).catch(() => undefined);
    if (temporaryStorageDirectory) await rm(temporaryStorageDirectory, { recursive: true, force: true }).catch(() => undefined);
    await pool.end();
  }
});
