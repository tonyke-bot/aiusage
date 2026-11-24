import { Database, constants } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityCopies } from "../src/antigravity";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), "aiusage-antigravity-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const conversations = join(home, ".gemini/antigravity-cli/conversations");
  mkdirSync(conversations, { recursive: true });
  const copies = new AntigravityCopies(home, join(base, "copies"));
  return { base, home, conversations, copies, copied: join(base, "copies/.gemini/antigravity-cli/conversations") };
}

/** Adds rows to a conversation database the way Antigravity keeps it, in WAL mode. */
function write(path: string, rows: string[]): Database {
  const db = new Database(path, { create: true });
  // Like Antigravity's SQLite, delete the WAL on close. The SQLite that Bun uses on macOS keeps it.
  db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  db.run("PRAGMA journal_mode = WAL");
  // Keeps the rows in the WAL until the database closes.
  db.run("PRAGMA wal_autocheckpoint = 0");
  db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)");
  for (const row of rows) db.run("INSERT INTO gen_metadata (data) VALUES (?)", [row]);
  return db;
}

function read(path: string): unknown[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT data FROM gen_metadata ORDER BY idx").values().flat();
  } finally {
    db.close();
  }
}

test("copies closed databases out of a read-only folder", () => {
  const { base, conversations, copies, copied } = setup();
  write(join(conversations, "a.db"), ["one"]).close();
  expect(existsSync(join(conversations, "a.db-wal"))).toBe(false);
  chmodSync(conversations, 0o555);
  cleanups.push(() => chmodSync(conversations, 0o755));

  expect(copies.update()).toEqual([join(base, "copies/.gemini/antigravity-cli")]);
  expect(read(join(copied, "a.db"))).toEqual(["one"]);
});

test("copies the WAL of a database that Antigravity has open", () => {
  const { conversations, copies, copied } = setup();
  const db = write(join(conversations, "a.db"), ["one", "two"]);
  cleanups.push(() => db.close());
  expect(existsSync(join(conversations, "a.db-wal"))).toBe(true);

  copies.update();
  expect(read(join(copied, "a.db"))).toEqual(["one", "two"]);
});

test("copies a database again only after it changes, and drops deleted ones", () => {
  const { conversations, copies, copied } = setup();
  write(join(conversations, "a.db"), ["one"]).close();
  copies.update();
  // A row only the copy has shows whether the next update replaced the copy.
  const copy = new Database(join(copied, "a.db"));
  copy.run("INSERT INTO gen_metadata (data) VALUES ('copy only')");
  copy.close();

  copies.update();
  expect(read(join(copied, "a.db"))).toEqual(["one", "copy only"]);

  write(join(conversations, "a.db"), ["two"]).close();
  copies.update();
  expect(read(join(copied, "a.db"))).toEqual(["one", "two"]);

  rmSync(join(conversations, "a.db"));
  copies.update();
  expect(existsSync(join(copied, "a.db"))).toBe(false);
});

test("returns no roots when no Antigravity folder is mounted", () => {
  const { base, copies } = setup();
  rmSync(join(base, "home"), { recursive: true });
  expect(copies.update()).toEqual([]);
});
