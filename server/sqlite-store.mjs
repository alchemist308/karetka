import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const defaultDatabase = () => resolve(process.env.KARETKA_DB_PATH || "var/karetka.sqlite");

export function openStores(filename = defaultDatabase()) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS objects (
      bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, metadata TEXT NOT NULL,
      etag TEXT NOT NULL, PRIMARY KEY(bucket,key)
    ) WITHOUT ROWID;
  `);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  const data = db.prepare("SELECT value FROM objects WHERE bucket=? AND key=?");
  const details = db.prepare("SELECT value, metadata, etag FROM objects WHERE bucket=? AND key=?");
  const metadata = db.prepare("SELECT metadata, etag FROM objects WHERE bucket=? AND key=?");
  const items = db.prepare("SELECT key, etag FROM objects WHERE bucket=? AND key>=? AND key<? ORDER BY key");
  const create = db.prepare("INSERT INTO objects(bucket,key,value,metadata,etag) VALUES(?,?,?,?,?) ON CONFLICT(bucket,key) DO NOTHING");
  const replace = db.prepare("UPDATE objects SET value=?,metadata=?,etag=? WHERE bucket=? AND key=? AND etag=?");
  const write = db.prepare(`INSERT INTO objects(bucket,key,value,metadata,etag) VALUES(?,?,?,?,?)
    ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value, metadata=excluded.metadata, etag=excluded.etag`);
  const remove = db.prepare("DELETE FROM objects WHERE bucket=? AND key=?");
  const view = (bucket) => ({
    async get(key, { type } = {}) {
      const row = data.get(bucket, key);
      return row ? (type === "json" ? JSON.parse(row.value) : row.value) : null;
    },
    async getMetadata(key) {
      const row = metadata.get(bucket, key);
      return row ? { metadata: JSON.parse(row.metadata), etag: row.etag } : null;
    },
    async getWithMetadata(key, { type } = {}) {
      const row = details.get(bucket, key);
      return row ? { data: type === "json" ? JSON.parse(row.value) : row.value, metadata: JSON.parse(row.metadata), etag: row.etag } : null;
    },
    async setJSON(key, value, { onlyIfNew = false, onlyIfMatch, metadata = {} } = {}) {
      const json = JSON.stringify(value);
      const meta = JSON.stringify(metadata);
      const etag = randomUUID();
      let result;
      if (onlyIfNew) result = create.run(bucket, key, json, meta, etag);
      else if (onlyIfMatch !== undefined) result = replace.run(json, meta, etag, bucket, key, onlyIfMatch);
      else result = write.run(bucket, key, json, meta, etag);
      return result.changes ? { modified: true, etag } : { modified: false };
    },
    list({ prefix = "", paginate = false } = {}) {
      // The app uses ASCII identifiers. Indexed bounds keep each namespace independent.
      const read = () => ({ blobs: items.all(bucket, prefix, prefix + "\u{10ffff}"), directories: [] });
      if (paginate) return (async function* () { yield read(); })();
      return Promise.resolve(read());
    },
    async delete(key) { remove.run(bucket, key); }
  });
  return { legacy: view("legacy"), commerce: view("commerce"), close: () => db.close() };
}

export function verifyDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").all();
    if (check.length !== 1 || check[0].integrity_check !== "ok") {
      throw new Error("SQLite обнаружила повреждение данных.");
    }
    // Check that this is a Karetka backup, not merely a valid, unrelated SQLite database.
    db.prepare("SELECT bucket,key,value,metadata,etag FROM objects LIMIT 1").get();
  } finally { db.close(); }
}

function ensureNewPath(filename) {
  if (["", "-wal", "-shm", "-journal"].some(suffix => existsSync(filename + suffix)))
    throw new Error("Путь назначения уже используется. Выберите новый файл или новый том.");
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
}

export function backupDatabase(source, destination) {
  const target = resolve(destination);
  ensureNewPath(target);
  const temp = mkdtempSync(join(dirname(target), ".karetka-backup-"));
  const copy = join(temp, "copy.sqlite");
  try {
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=15000");
      db.prepare("VACUUM INTO ?").run(copy);
    } finally { db.close(); }
    verifyDatabase(copy);
    installNew(copy, target);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function installNew(file, destination) {
  chmodSync(file, 0o600);
  const fd = openSync(file, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  // Link is atomic and rejects an existing destination, even after our initial check.
  linkSync(file, destination);
  const directory = openSync(dirname(destination), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function restoreDatabase(source, destination) {
  const target = resolve(destination);
  ensureNewPath(target);
  const temp = mkdtempSync(join(dirname(target), ".karetka-restore-"));
  const copy = join(temp, "restored.sqlite");
  try {
    copyFileSync(source, copy);
    verifyDatabase(copy);
    installNew(copy, target);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  const [operation, file] = process.argv.slice(2);
  let temporaryDirectory;
  try {
    if (!file) throw new Error("Нужен путь к резервной копии.");
    if (!["backup", "verify", "restore"].includes(operation)) throw new Error("Команды: backup, verify, restore.");
    let path = resolve(file);
    if (file === "-") {
      const parent = dirname(defaultDatabase());
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      temporaryDirectory = mkdtempSync(join(parent, ".karetka-transfer-"));
      path = join(temporaryDirectory, "backup.sqlite");
      if (operation !== "backup")
        await pipeline(process.stdin, createWriteStream(path, { mode: 0o600, flags: "wx" }));
    }
    if (operation === "backup") {
      backupDatabase(defaultDatabase(), path);
      if (file === "-") await pipeline(createReadStream(path), process.stdout);
    } else if (operation === "verify") verifyDatabase(path);
    else restoreDatabase(path, defaultDatabase());
    if (file !== "-" || operation !== "backup") console.log("Готово.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true }); }
}
