import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config as loadDotEnv } from "dotenv";
import { dirname, resolve } from "node:path";
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

test("PostgreSQL migrations, persistence, expiration, atomic layout consumption and v2/v3 templates", async () => {
  const connectionString = localDatabaseUrl();
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 });
  const sessionIds: string[] = [];
  const temporaryLayoutIds: string[] = [];
  let repository = createRepository(connectionString);
  let secondRepository: ReturnType<typeof createRepository> | undefined;

  try {
    const databaseIdentity = await pool.query<{ current_database: string }>("SELECT current_database()");
    assert.equal(databaseIdentity.rows[0]?.current_database, "curriculus_local");

    const migrationRows = await pool.query<{ version: string }>(
      "SELECT version FROM curriculus_schema_migrations ORDER BY version",
    );
    const appliedMigrations = new Set(migrationRows.rows.map((row) => row.version));
    for (const migration of requiredMigrations) {
      assert.ok(appliedMigrations.has(migration), `Migration ${migration} has not been applied.`);
    }
    assert.equal(await repository.isReady(), true, "The migrated repository schema must be ready.");

    for (const [version, template] of [["v2", templateV2], ["v3", templateV3]] as const) {
      const session = await repository.createSession({ ...analysisInput, resumeLayoutTemplate: template });
      sessionIds.push(session.id);
      await repository.close();
      repository = createRepository(connectionString);

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
  } finally {
    if (sessionIds.length > 0) {
      await pool.query("DELETE FROM analysis_sessions WHERE id = ANY($1::uuid[])", [sessionIds]).catch(() => undefined);
    }
    if (temporaryLayoutIds.length > 0) {
      await pool.query("DELETE FROM temporary_resume_layouts WHERE id = ANY($1::uuid[])", [temporaryLayoutIds]).catch(() => undefined);
    }
    await secondRepository?.close();
    await repository.close();
    await pool.end();
  }
});
