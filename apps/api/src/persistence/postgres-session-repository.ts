import { Pool } from "pg";
import {
  PostgresSessionRepository,
  type Database,
  type QueryResult,
} from "./session-repository.js";

class PostgresDatabase implements Database {
  constructor(private readonly pool: Pool) {}

  async query<Row extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.pool.query(sql, [...values]);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createConfiguredSessionRepository(
  environment: NodeJS.ProcessEnv = process.env,
): PostgresSessionRepository | undefined {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) return undefined;

  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", () => {
    process.stderr.write("An idle database connection failed.\n");
  });

  return new PostgresSessionRepository(new PostgresDatabase(pool));
}
