import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
class D1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  async first(column) { const value = this.database.prepare(this.sql).get(...this.values) || null; return column && value ? value[column] : value; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values), success: true, meta: { changes: 0 } }; }
  run() { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
  execute() { return /^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql) ? this.all() : this.run(); }
}
class D1Local {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const statement of statements) results.push(statement.execute()); this.database.exec('COMMIT'); return results; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}
function bucketObject(data) {
  const bytes = new Uint8Array(data);
  return { size: bytes.length, body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.slice().buffer };
}
class MemoryBucket {
  objects = new Map();
  async put(key, data) { this.objects.set(key, new Uint8Array(data).slice()); }
  async get(key) { return this.objects.has(key) ? bucketObject(this.objects.get(key)) : null; }
  async delete(key) { this.objects.delete(key); }
}
class FileBucket {
  constructor(directory) { this.directory = path.resolve(directory); }
  filename(key) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9/_-]+$/.test(key)) throw new Error('Invalid object key');
    const target = path.resolve(this.directory, key + '.bin');
    if (!target.startsWith(this.directory + path.sep)) throw new Error('Invalid object path');
    return target;
  }
  async put(key, bytes) { const target = this.filename(key); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' }); }
  async get(key) { try { return bucketObject(await readFile(this.filename(key))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async delete(key) { try { await unlink(this.filename(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

/** Local preview only. Hosted requests use Sites-managed D1/R2 bindings. */
export async function createLocalStorage({ memory = false, directory = path.join(project, '.local-data') } = {}) {
  if (!memory) await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(memory ? ':memory:' : path.join(directory, 'records.sqlite'));
  database.exec('PRAGMA foreign_keys = ON');
  // Infrastructure setup runs once at server startup, never during a product request.
  database.exec('CREATE TABLE IF NOT EXISTS _local_migrations (tag TEXT PRIMARY KEY)');
  const journal = JSON.parse(await readFile(path.join(project, 'drizzle/meta/_journal.json'), 'utf8'));
  for (const entry of journal.entries) {
    if (database.prepare('SELECT tag FROM _local_migrations WHERE tag = ?').get(entry.tag)) continue;
    const migration = await readFile(path.join(project, 'drizzle', entry.tag + '.sql'), 'utf8');
    database.exec('BEGIN IMMEDIATE');
    try { database.exec(migration); database.prepare('INSERT INTO _local_migrations(tag) VALUES (?)').run(entry.tag); database.exec('COMMIT'); }
    catch (error) { database.exec('ROLLBACK'); database.close(); throw error; }
  }
  return { DB: new D1Local(database), BUCKET: memory ? new MemoryBucket() : new FileBucket(path.join(directory, 'files')), close: () => database.close() };
}
