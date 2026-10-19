import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: "drizzle" });
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

export { schema };
