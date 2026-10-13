import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadEnvironmentFiles } from "../src/load-environment.js";

loadEnvironmentFiles();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL before running database migrations.");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const migrationsDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../migrations",
  );
  const lockId = 731_408_211;

  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [lockId]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS curriculus_schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const migrationFiles = (await readdir(migrationsDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort();

      for (const file of migrationFiles) {
        const alreadyApplied = await client.query(
          "SELECT version FROM curriculus_schema_migrations WHERE version = $1",
          [file],
        );
        if (alreadyApplied.rows.length > 0) continue;

        const migrationSql = await readFile(
          resolve(migrationsDirectory, file),
          "utf8",
        );

        await client.query("BEGIN");
        try {
          await client.query(migrationSql);
          await client.query(
            "INSERT INTO curriculus_schema_migrations (version) VALUES ($1)",
            [file],
          );
          await client.query("COMMIT");
          console.info(`Applied database migration: ${file}`);
        } catch {
          await client.query("ROLLBACK");
          throw new Error("Database migration failed.");
        }
      }

      await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    } finally {
      client.release();
    }
  } catch {
    console.error("Database migration failed; check connectivity and SQL configuration.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
