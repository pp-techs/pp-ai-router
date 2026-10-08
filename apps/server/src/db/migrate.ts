import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Applies `NNN_name.sql` files whose number is above `PRAGMA user_version`, each in one transaction. */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const files = readdirSync(MIGRATIONS_DIR)
    .map((name) => ({ name, match: /^(\d+)_.+\.sql$/.exec(name) }))
    .flatMap(({ name, match }) => (match ? [{ name, version: Number(match[1]) }] : []))
    .sort((a, b) => a.version - b.version);

  for (const file of files) {
    if (file.version <= row.user_version) continue;
    const sql = readFileSync(MIGRATIONS_DIR + file.name, "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${file.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${file.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
}
