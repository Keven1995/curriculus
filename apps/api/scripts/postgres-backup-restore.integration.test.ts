import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { config as loadDotEnv } from "dotenv";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { createConfiguredSessionRepository } from "../src/persistence/postgres-session-repository.js";

loadDotEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env.postgres"),
  quiet: true,
});

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  assert.ok(raw, "Set TEST_DATABASE_URL in .env.postgres before running backup/restore tests.");
  const url = new URL(raw);
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname));
  assert.equal(url.port || "5432", "5434");
  assert.equal(url.pathname, "/curriculus_local");
  return raw;
}

function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^curriculus_backup_(?:src|restore)_[a-f0-9]{32}$/);
  return `"${identifier}"`;
}

function escapePassfileField(value: string): string {
  return value.replace(/[\\:]/g, "\\$&");
}

function runProcess(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1_000); });
    child.once("error", () => rejectProcess(new Error(`${command} could not be started.`)));
    child.once("exit", (code) => {
      if (code === 0) resolveProcess(Buffer.concat(stdout));
      else rejectProcess(new Error(`${command} failed (${code ?? "unknown"}): ${stderr.slice(-500)}`));
    });
    child.stdin.end(input);
  });
}

function createRepository(databaseUrl: string) {
  const repository = createConfiguredSessionRepository({ DATABASE_URL: databaseUrl });
  assert.ok(repository);
  return repository;
}

test("backs up and restores only synthetic data through isolated disposable databases", async () => {
  const mainDatabaseUrl = testDatabaseUrl();
  const mainUrl = new URL(mainDatabaseUrl);
  const adminPool = new Pool({ connectionString: mainDatabaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const nonce = randomUUID().replaceAll("-", "");
  const sourceDatabase = `curriculus_backup_src_${nonce}`;
  const restoreDatabase = `curriculus_backup_restore_${nonce}`;
  const databaseNames: string[] = [];
  const repositories: Array<ReturnType<typeof createRepository>> = [];
  let sourcePool: Pool | undefined;
  let restorePool: Pool | undefined;
  let passfilePath: string | undefined;
  let backupDirectory: string | undefined;
  let dockerContainerId: string | undefined;

  try {
    const identity = await adminPool.query<{
      current_database: string;
      server_port: number;
      role_can_create_database: boolean;
    }>(`SELECT current_database(), inet_server_port() AS server_port,
               (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS role_can_create_database`);
    assert.equal(identity.rows[0]?.current_database, "curriculus_local");
    assert.equal(identity.rows[0]?.server_port, 5432);
    assert.equal(identity.rows[0]?.role_can_create_database, true);

    const collisionCheck = await adminPool.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
      [[sourceDatabase, restoreDatabase]],
    );
    assert.equal(collisionCheck.rowCount, 0, "disposable database names must be new before creation");

    const dockerIds = (await runProcess("docker", ["ps", "--filter", "publish=5434", "--format", "{{.ID}}"])).toString("utf8").trim().split(/\s+/).filter(Boolean);
    assert.equal(dockerIds.length, 1, "expected exactly one local PostgreSQL container published on port 5434");
    dockerContainerId = dockerIds[0]!;

    const sourceVersionUrl = databaseUrlFor(mainDatabaseUrl, sourceDatabase);
    const restoreUrl = databaseUrlFor(mainDatabaseUrl, restoreDatabase);
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(sourceDatabase)}`);
    databaseNames.push(sourceDatabase);
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(restoreDatabase)}`);
    databaseNames.push(restoreDatabase);

    sourcePool = new Pool({ connectionString: sourceVersionUrl, max: 1, connectionTimeoutMillis: 5_000 });
    const migrationsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
    const { readdir: readDirectory } = await import("node:fs/promises");
    const migrationFiles = (await readDirectory(migrationsPath)).filter((file) => file.endsWith(".sql")).sort();
    const migrationClient = await sourcePool.connect();
    try {
      await migrationClient.query(`CREATE TABLE curriculus_schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      for (const file of migrationFiles) {
        const sql = await readFile(resolve(migrationsPath, file), "utf8");
        await migrationClient.query("BEGIN");
        try {
          await migrationClient.query(sql);
          await migrationClient.query("INSERT INTO curriculus_schema_migrations (version) VALUES ($1)", [file]);
          await migrationClient.query("COMMIT");
        } catch {
          await migrationClient.query("ROLLBACK");
          throw new Error("Migration failed in disposable backup source database.");
        }
      }
    } finally {
      migrationClient.release();
    }

    const sourceRepository = createRepository(sourceVersionUrl);
    repositories.push(sourceRepository);
    const syntheticResume = "Synthetic backup fixture only; no real personal data.";
    const session = await sourceRepository.createSession({
      jobDescription: "Synthetic backup/restore test position.",
      resume: syntheticResume,
      analysis: { jobRequirements: [], suggestions: [], documentStructure: { sectionOrder: [], suggestionOrder: [] } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: null },
    });
    const order = await sourceRepository.createPendingOrder(session.id);
    assert.ok(order);
    const paymentId = `synthetic-${randomUUID()}`;
    assert.equal(await sourceRepository.attachProviderPaymentId(order.id, paymentId), true);
    assert.equal(await sourceRepository.updateOrderStatusByProviderPaymentId(paymentId, "approved"), true);
    const rateLimitHash = createHash("sha256").update(randomUUID()).digest("hex");
    const backupBucket = await sourceRepository.consumeDistributedRateLimit!("backup", rateLimitHash, {
      limit: 5,
      windowMs: 60_000,
    });
    assert.equal(backupBucket.allowed, true);
    assert.equal(backupBucket.remaining, 4);
    assert.ok(backupBucket.retryAfterSeconds >= 1 && backupBucket.retryAfterSeconds <= 60);
    await sourceRepository.close();
    repositories.pop();
    await sourcePool.end();
    sourcePool = undefined;

    const urlCredentials = {
      username: decodeURIComponent(mainUrl.username),
      password: decodeURIComponent(mainUrl.password),
    };
    passfilePath = `/tmp/curriculus-backup-${nonce}.pgpass`;
    const passfileEntry = ["127.0.0.1", "5432", "*", urlCredentials.username, urlCredentials.password]
      .map(escapePassfileField)
      .join(":") + "\n";
    await runProcess("docker", [
      "exec", "-i", "--user", "postgres", dockerContainerId,
      "sh", "-c", `umask 077 && cat > '${passfilePath}'`,
    ], Buffer.from(passfileEntry, "utf8"));

    backupDirectory = await mkdtemp(join(process.env.LOCALAPPDATA ?? process.cwd(), "Temp", "opencode", "curriculus-backup-"));
    const backupFile = join(backupDirectory, "synthetic-only.dump");
    const archive = await runProcess("docker", [
      "exec", "--user", "postgres", "--env", `PGPASSFILE=${passfilePath}`, dockerContainerId,
      "pg_dump", "--host=127.0.0.1", "--port=5432", "--username", urlCredentials.username,
      "--format=custom", "--no-owner", "--no-acl", "--dbname", sourceDatabase,
    ]);
    assert.ok(archive.length > 0, "pg_dump must produce a non-empty archive");
    await writeFile(backupFile, archive, { flag: "wx" });

    const restoredArchive = await readFile(backupFile);
    await runProcess("docker", [
      "exec", "-i", "--user", "postgres", "--env", `PGPASSFILE=${passfilePath}`, dockerContainerId,
      "pg_restore", "--host=127.0.0.1", "--port=5432", "--username", urlCredentials.username,
      "--dbname", restoreDatabase, "--no-owner", "--no-acl", "--exit-on-error",
    ], restoredArchive);

    restorePool = new Pool({ connectionString: restoreUrl, max: 1, connectionTimeoutMillis: 5_000 });
    const restoredMigrations = await restorePool.query<{ version: string }>(
      "SELECT version FROM curriculus_schema_migrations ORDER BY version",
    );
    assert.equal(restoredMigrations.rowCount, migrationFiles.length);
    assert.equal(restoredMigrations.rows.at(-1)?.version, "006_distributed_rate_limits.sql");

    const restoredRepository = createRepository(restoreUrl);
    repositories.push(restoredRepository);
    assert.equal(await restoredRepository.isReady(), true);
    const restoredSession = await restoredRepository.findActiveSession(session.id);
    assert.equal(restoredSession?.resume, syntheticResume);
    assert.equal(restoredSession?.jobDescription, "Synthetic backup/restore test position.");
    const restoredOrder = await restoredRepository.findOrderBySessionId(session.id);
    assert.equal(restoredOrder?.status, "approved");
    assert.equal(restoredOrder?.providerPaymentId, paymentId);
    const restoredBucket = await restorePool.query<{ request_count: number }>(
      "SELECT request_count FROM rate_limit_buckets WHERE scope = 'backup' AND client_hash = $1",
      [rateLimitHash],
    );
    assert.equal(restoredBucket.rows[0]?.request_count, 1);
    assert.equal(restoredSession?.resume, syntheticResume);

    console.log(`Synthetic backup archive created and restored to disposable database ${restoreDatabase}.`);
  } finally {
    for (const repository of repositories) await repository.close?.().catch(() => undefined);
    await sourcePool?.end().catch(() => undefined);
    await restorePool?.end().catch(() => undefined);
    for (const database of databaseNames.reverse()) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`).catch(() => undefined);
    }
    if (databaseNames.length > 0) {
      const residue = await adminPool.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
        [databaseNames],
      );
      assert.equal(residue.rowCount, 0, "only the disposable databases created for this test may be dropped");
    }
    if (passfilePath && dockerContainerId) {
      await runProcess("docker", [
        "exec", "--user", "postgres", dockerContainerId,
        "sh", "-c", `rm -f -- '${passfilePath}'`,
      ]).catch(() => undefined);
    }
    if (backupDirectory) await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    await adminPool.end();
  }
});
