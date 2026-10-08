import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { migrate } from "./migrate.ts";

export type Db = DatabaseSync;
export type Param = SQLInputValue;

export function openDatabase(path: string): Db {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** Runs `fn` inside BEGIN IMMEDIATE ... COMMIT. Not re-entrant. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function one<T>(stmt: StatementSync, ...params: Param[]): T | undefined {
  return stmt.get(...params) as T | undefined;
}

export function all<T>(stmt: StatementSync, ...params: Param[]): T[] {
  return stmt.all(...params) as T[];
}
