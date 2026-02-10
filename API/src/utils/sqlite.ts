import Database from 'better-sqlite3';

export type SqliteOpenOptions = {
  timeoutMs?: number;
};

/**
 * Open a connection suitable for reading a WAL-enabled database that may be
 * concurrently written by another process.
 *
 * IMPORTANT:
 * - In WAL mode, SQLite readers participate in coordination via the `-shm` file.
 * - Opening the main database as SQLITE_OPEN_READONLY can break that coordination
 *   and lead to transient IO errors (e.g. SHORT_READ) if the writer checkpoints/truncates.
 *
 * So we open read-write, then enforce read-only at the SQL layer via `PRAGMA query_only=ON`.
 */
export function openSqliteForRead(dbPath: string, opts: SqliteOpenOptions = {}): Database.Database {
  const timeoutMs = opts.timeoutMs ?? 5000;

  const db = new Database(dbPath, {
    // Must exist; callers use existence checks only for UX, not correctness.
    fileMustExist: true,
    timeout: timeoutMs,
  });

  // Ensure the connection will wait for locks instead of failing immediately.
  // (The `timeout` option also sets this, but being explicit makes intent clear.)
  db.pragma(`busy_timeout = ${timeoutMs}`);

  // Enforce read-only at the SQL layer while still allowing WAL shared-memory coordination.
  db.pragma('query_only = ON');

  return db;
}

