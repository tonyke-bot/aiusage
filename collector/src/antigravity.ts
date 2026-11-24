import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage, log } from "./util";

/** The folders ccusage reads Antigravity data from, relative to the home folder. */
export const ANTIGRAVITY_ROOTS = [
  ".gemini/antigravity",
  ".gemini/antigravity-cli",
  ".gemini/antigravity-ide",
  ".gemini/antigravity-backup",
  ".gemini/antigravity-acp",
  ".config/antigravity",
];

const COPY_TRIES = 3;

type SourceState = { key: string; hasWal: boolean };

/**
 * Copies of Antigravity's conversation databases, for ccusage to read.
 *
 * Antigravity keeps each conversation in a SQLite database in WAL mode. While Antigravity has a
 * database open, -wal and -shm files sit next to it. When Antigravity closes it, they are deleted,
 * and SQLite can only open the database again by creating them. A read-only mount doesn't allow
 * that, so ccusage would skip every conversation that isn't open. Copies in a writable folder
 * don't have that problem.
 */
export class AntigravityCopies {
  /** The source state each copy was made from, by the copy's path. */
  readonly #copied = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly dir: string,
  ) {}

  /** Brings the copies up to date and returns their data roots, one per mounted folder. */
  update(): string[] {
    const roots: string[] = [];
    for (const root of ANTIGRAVITY_ROOTS) {
      const source = join(this.home, root, "conversations");
      if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) continue;
      const copy = join(this.dir, root);
      // A failed copy shouldn't hold up the other agents' usage. ccusage still reads the copies
      // that are there.
      try {
        this.#sync(source, join(copy, "conversations"));
      } catch (error) {
        log(`antigravity: couldn't copy ${source}: ${errorMessage(error)}`);
      }
      roots.push(copy);
    }
    return roots;
  }

  #sync(source: string, target: string): void {
    const names = new Set(databases(source));
    for (const name of names) this.#copy(join(source, name), join(target, name));
    for (const name of databases(target)) {
      if (names.has(name)) continue;
      removeDatabase(join(target, name));
      this.#copied.delete(join(target, name));
    }
  }

  #copy(from: string, to: string): void {
    let state = sourceState(from);
    if (state && this.#copied.get(to) === state.key) return;
    this.#copied.delete(to);
    removeDatabase(to);
    mkdirSync(dirname(to), { recursive: true });
    // Antigravity can write while the files are copied. A copy only counts if the database and
    // its WAL stayed the same throughout, so the two match.
    let failure: unknown;
    for (let attempt = 0; state && attempt < COPY_TRIES; attempt++) {
      let copied = false;
      try {
        copyFileSync(from, to);
        if (state.hasWal) copyFileSync(`${from}-wal`, `${to}-wal`);
        copied = true;
      } catch (error) {
        failure = error;
      }
      const after = sourceState(from);
      if (copied && after?.key === state.key) {
        try {
          leaveWalMode(to);
          this.#copied.set(to, state.key);
          return;
        } catch (error) {
          failure = error;
        }
      }
      removeDatabase(to);
      state = after;
    }
    if (state) {
      const reason = failure ? errorMessage(failure) : "it kept changing";
      log(`antigravity: couldn't copy ${from} (${reason}), trying again next pass`);
    }
  }
}

/**
 * Moves a copy's WAL into the database file and takes it out of WAL mode. A read-only connection
 * then opens it without -wal or -shm files, whatever SQLite build ccusage has.
 */
function leaveWalMode(path: string): void {
  const db = new Database(path);
  try {
    db.run("PRAGMA journal_mode = DELETE");
  } finally {
    db.close();
  }
  // macOS's SQLite keeps an empty WAL after a checkpoint.
  for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

function sourceState(database: string): SourceState | undefined {
  const main = statSync(database, { bigint: true, throwIfNoEntry: false });
  if (!main?.isFile()) return undefined;
  const wal = statSync(`${database}-wal`, { bigint: true, throwIfNoEntry: false });
  return { key: [main.size, main.mtimeNs, wal?.size, wal?.mtimeNs].join(":"), hasWal: wal !== undefined };
}

/** The .db files below a folder, relative to it. */
function databases(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (name) => name.endsWith(".db") && statSync(join(dir, name), { throwIfNoEntry: false })?.isFile(),
  );
}

function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}
