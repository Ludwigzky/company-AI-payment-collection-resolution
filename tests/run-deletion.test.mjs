import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { handleAPI } from '../src/api.js';
import {
  RecordError, createRecord, getRecord, listRecords, updateRecord,
  addAttachment, addNote, saveRun, deleteRun, restoreRun,
} from '../src/records.js';

const migrationDirectory = new URL('../drizzle/', import.meta.url);
const migrations = readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort();
const migrationSQL = (name) => readFileSync(new URL(name, migrationDirectory), 'utf8');
const owner = 'owner-a';
const origin = 'https://workspace.example';

function adapter(sqlite) {
  return {
    prepare(sql) {
      assert.ok(!sql.includes(';'), 'request SQL must contain one operation');
      assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|DELETE)\b/i, 'visibility requests cannot remove rows or manage tables');
      const native = sqlite.prepare(sql);
      return {
        sql, values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return native.get(...this.values) ?? null; },
        async all() { return { results: native.all(...this.values), meta: { changes: 0 } }; },
        async run() { return { results: [], meta: { changes: Number(native.run(...this.values).changes) } }; },
        execute() {
          return native.columns().length
            ? { results: native.all(...this.values), meta: { changes: 0 } }
            : { results: [], meta: { changes: Number(native.run(...this.values).changes) } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  migrations.forEach((name) => sqlite.exec(migrationSQL(name)));
  let bucketCalls = 0;
  const fileAccess = () => { bucketCalls += 1; throw new Error('run visibility must not access files'); };
  const env = { DB: adapter(sqlite), BUCKET: { put: fileAccess, get: fileAccess, delete: fileAccess } };
  t.after(() => { assert.equal(bucketCalls, 0); sqlite.close(); });
  return { sqlite, env };
}

const snapshot = (record, overrides = {}) => ({
  revision: record.revision, inputSnapshot: record.input, attachmentIds: [],
  plan: { strategy: '核对本版本的付款资料。', nested: { retained: ['原始方案', 123] } },
  materialSummary: [{ text: '保留原始材料摘要。' }], ...overrides,
});
const rejectStatus = (operation, status) => assert.rejects(operation, (error) => error instanceof RecordError && error.status === status);
const rawRun = (sqlite, id) => ({ ...sqlite.prepare('SELECT * FROM recovery_runs WHERE id = ?').get(id) });
const snapshotColumns = ({ deleted_at, state_version, ...row }) => row;
const rawTable = (sqlite, table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }));

function request(path, { method = 'GET', body, user = owner, headers = {} } = {}) {
  return new Request(origin + '/api/records' + path, {
    method,
    headers: { Origin: origin, ...(user ? { 'oai-authenticated-user-id': user } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const call = (env, path, options) => handleAPI(request(path, options), env);

test('additive migration upgrades existing snapshots with defaults and preserves rows, keys and foreign keys', (t) => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  migrations.filter((name) => !name.startsWith('0003_')).forEach((name) => sqlite.exec(migrationSQL(name)));
  sqlite.prepare(`INSERT INTO recovery_records (id, owner_id, number, title, status, revision, input_json, created_at, updated_at)
    VALUES ('case', 'owner', 'RC-OLD', '旧案件', 'active', 1, '{}', 'old', 'old')`).run();
  sqlite.prepare(`INSERT INTO recovery_runs (id, owner_id, record_id, revision, input_json, attachment_ids_json, plan_json, material_summary_json, snapshot_stale, created_at)
    VALUES ('run', 'owner', 'case', 1, '{ "amount": 12 }', '[]', '{ "strategy": "原样保留" }', 'null', 0, 'old')`).run();
  const before = rawRun(sqlite, 'run');
  const indexes = sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recovery_runs' ORDER BY name").all();
  const foreignKeys = sqlite.prepare('PRAGMA foreign_key_list(recovery_runs)').all();
  const migration = migrationSQL(migrations.find((name) => name.startsWith('0003_')));
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|CREATE|INSERT)\b/i);
  sqlite.exec(migration);
  const after = rawRun(sqlite, 'run');
  assert.deepEqual(snapshotColumns(after), before);
  assert.equal(after.deleted_at, null);
  assert.equal(after.state_version, 0);
  assert.deepEqual(sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recovery_runs' ORDER BY name").all(), indexes);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_list(recovery_runs)').all(), foreignKeys);
  assert.throws(() => sqlite.prepare('UPDATE recovery_runs SET state_version = -1').run(), /CHECK/);
  assert.throws(() => sqlite.prepare('UPDATE recovery_runs SET state_version = NULL').run(), /NOT NULL/);
});

test('deleting one version retains its exact snapshot and all case data; restore changes only visibility', async (t) => {
  const { env, sqlite } = fixture(t);
  let record = await createRecord(env, owner, { title: '保留资料案件', input: { debtorName: '原债务人', amount: 1200 } });
  const file = await addAttachment(env, owner, record.id, { name: '原始合同.pdf', mime: 'application/pdf', size: 1024, sha256: 'a'.repeat(64), objectKey: 'private/keep-original' });
  await addNote(env, owner, record.id, { body: '保留全部跟进记录。' });
  record = await getRecord(env, owner, record.id);
  const first = await saveRun(env, owner, record.id, snapshot(record, { attachmentIds: [file.id] }));
  const second = await saveRun(env, owner, record.id, snapshot(record, { plan: { strategy: '第二个独立方案。' } }));
  assert.equal(first.deletedAt, null);
  assert.equal(first.stateVersion, 0);
  const original = rawRun(sqlite, first.id);
  const other = rawRun(sqlite, second.id);
  const files = rawTable(sqlite, 'recovery_attachments');
  const notes = rawTable(sqlite, 'recovery_notes');
  sqlite.prepare("UPDATE recovery_records SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(record.id);
  const deleted = await deleteRun(env, owner, record.id, first.id, { stateVersion: 0 });
  assert.match(deleted.run.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(deleted.run.stateVersion, 1);
  assert.equal(deleted.record.runs.length, 2, 'tombstones remain available on every record response');
  assert.equal(deleted.record.runs.find((run) => run.id === second.id).deletedAt, null);
  assert.equal((await listRecords(env, owner))[0].runCount, 1);
  assert.deepEqual(snapshotColumns(rawRun(sqlite, first.id)), snapshotColumns(original));
  assert.deepEqual(rawRun(sqlite, second.id), other);
  assert.equal(deleted.record.revision, record.revision);
  assert.deepEqual(deleted.record.input, record.input);
  assert.ok(deleted.record.updatedAt > '2000-01-01T00:00:00.000Z');
  const restored = await restoreRun(env, owner, record.id, first.id, { stateVersion: 1 });
  assert.equal(restored.run.deletedAt, null);
  assert.equal(restored.run.stateVersion, 2);
  assert.deepEqual(snapshotColumns(rawRun(sqlite, first.id)), snapshotColumns(original));
  assert.equal((await listRecords(env, owner))[0].runCount, 2);
  assert.equal(restored.record.revision, record.revision);
  assert.deepEqual(restored.record.input, record.input);
  assert.deepEqual(rawTable(sqlite, 'recovery_attachments'), files);
  assert.deepEqual(rawTable(sqlite, 'recovery_notes'), notes);
  assert.equal(sqlite.prepare('SELECT count(*) AS total FROM recovery_runs').get().total, 2);
});

test('owner, case and run must all match for delete and restore', async (t) => {
  const { env, sqlite } = fixture(t);
  const a = await createRecord(env, owner);
  const b = await createRecord(env, owner);
  const foreign = await createRecord(env, 'owner-b');
  const runA = await saveRun(env, owner, a.id, snapshot(a));
  const runB = await saveRun(env, owner, b.id, snapshot(b));
  const runForeign = await saveRun(env, 'owner-b', foreign.id, snapshot(foreign));
  const before = rawTable(sqlite, 'recovery_runs');
  for (const operation of [deleteRun, restoreRun]) {
    for (const args of [
      ['owner-b', a.id, runA.id], [owner, a.id, runB.id], [owner, a.id, runForeign.id],
      [owner, foreign.id, runForeign.id], [owner, 'missing', runA.id], [owner, a.id, 'missing'],
    ]) await rejectStatus(() => operation(env, ...args, { stateVersion: 0 }), 404);
  }
  assert.deepEqual(rawTable(sqlite, 'recovery_runs'), before);
});

test('retries are idempotent while stale opposite actions cannot undo a newer decision', async (t) => {
  const { env, sqlite } = fixture(t);
  const record = await createRecord(env, owner);
  const run = await saveRun(env, owner, record.id, snapshot(record));
  const deleted = await deleteRun(env, owner, record.id, run.id, { stateVersion: 0 });
  const parentAfterDelete = { ...sqlite.prepare('SELECT * FROM recovery_records WHERE id = ?').get(record.id) };
  const repeated = await deleteRun(env, owner, record.id, run.id, { stateVersion: 0 });
  assert.deepEqual(repeated.run, deleted.run);
  assert.deepEqual({ ...sqlite.prepare('SELECT * FROM recovery_records WHERE id = ?').get(record.id) }, parentAfterDelete);
  await rejectStatus(() => restoreRun(env, owner, record.id, run.id, { stateVersion: 0 }), 409);
  const restored = await restoreRun(env, owner, record.id, run.id, { stateVersion: 1 });
  assert.equal(restored.run.stateVersion, 2);
  assert.deepEqual((await restoreRun(env, owner, record.id, run.id, { stateVersion: 1 })).run, restored.run);
  await rejectStatus(() => deleteRun(env, owner, record.id, run.id, { stateVersion: 0 }), 409);
  const again = await deleteRun(env, owner, record.id, run.id, { stateVersion: 2 });
  assert.equal(again.run.stateVersion, 3);
  const writes = await Promise.allSettled([
    restoreRun(env, owner, record.id, run.id, { stateVersion: 3 }),
    deleteRun(env, owner, record.id, run.id, { stateVersion: 3 }),
  ]);
  assert.equal(writes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(writes.find(({ status }) => status === 'rejected').reason.status, 409);
  assert.equal((await getRecord(env, owner, record.id)).runs[0].stateVersion, 4);
});

test('archived cases reject changes and retries; an archive before the atomic batch cannot slip through', async (t) => {
  const { env, sqlite } = fixture(t);
  const record = await createRecord(env, owner);
  const first = await saveRun(env, owner, record.id, snapshot(record));
  const second = await saveRun(env, owner, record.id, snapshot(record));
  await deleteRun(env, owner, record.id, second.id, { stateVersion: 0 });
  const archived = await updateRecord(env, owner, record.id, { revision: record.revision, status: 'archived' });
  const before = rawTable(sqlite, 'recovery_runs');
  for (const operation of [deleteRun, restoreRun]) {
    for (const run of [first, second]) await rejectStatus(() => operation(env, owner, record.id, run.id, { stateVersion: run.id === first.id ? 0 : 1 }), 409);
  }
  assert.deepEqual(rawTable(sqlite, 'recovery_runs'), before);
  assert.deepEqual(await getRecord(env, owner, record.id), archived);
  await updateRecord(env, owner, record.id, { revision: archived.revision, status: 'active' });
  const batch = env.DB.batch.bind(env.DB);
  let raced = false;
  env.DB.batch = async (statements) => {
    if (!raced && statements.some(({ sql }) => /UPDATE recovery_runs SET deleted_at/.test(sql))) {
      raced = true;
      sqlite.prepare("UPDATE recovery_records SET status = 'archived', revision = revision + 1, updated_at = 'archive-race' WHERE owner_id = ? AND id = ?").run(owner, record.id);
    }
    return batch(statements);
  };
  await rejectStatus(() => deleteRun(env, owner, record.id, first.id, { stateVersion: 0 }), 409);
  assert.equal(raced, true);
  assert.deepEqual(rawTable(sqlite, 'recovery_runs'), before);
  assert.equal((await getRecord(env, owner, record.id)).updatedAt, 'archive-race');
});

test('deleting the last active version keeps the draft and a later generation appends without reviving it', async (t) => {
  const { env, sqlite } = fixture(t);
  const record = await createRecord(env, owner, { input: { amount: 5000, debtorName: '生成中的案件' } });
  const first = await saveRun(env, owner, record.id, snapshot(record));
  const capturedSnapshot = snapshot(record, { plan: { strategy: '删除期间已经开始的第二次生成。' } });
  const deleted = await deleteRun(env, owner, record.id, first.id, { stateVersion: 0 });
  assert.equal((await listRecords(env, owner))[0].runCount, 0);
  assert.equal(deleted.record.runs.filter((run) => !run.deletedAt).length, 0);
  assert.deepEqual(deleted.record.input, record.input);
  assert.equal(deleted.record.revision, record.revision);
  const tombstone = rawRun(sqlite, first.id);
  const newRun = await saveRun(env, owner, record.id, capturedSnapshot);
  assert.equal(newRun.deletedAt, null);
  assert.equal(newRun.stateVersion, 0);
  assert.equal(newRun.snapshotStale, false);
  assert.deepEqual(rawRun(sqlite, first.id), tombstone);
  const current = await getRecord(env, owner, record.id);
  assert.equal(current.runs.length, 2);
  assert.deepEqual(current.runs.filter((run) => !run.deletedAt).map(({ id }) => id), [newRun.id]);
  assert.equal((await listRecords(env, owner))[0].runCount, 1);
  assert.equal(current.revision, record.revision);
});

test('API delete and restore use trusted identity, same-origin protection and strict version bodies', async (t) => {
  const { env } = fixture(t);
  const record = await createRecord(env, owner);
  const run = await saveRun(env, owner, record.id, snapshot(record));
  const path = `/${record.id}/runs/${run.id}`;
  assert.equal((await call(env, path, { method: 'DELETE', user: '', body: { stateVersion: 0 } })).status, 401);
  assert.equal((await call(env, path, { method: 'DELETE', user: 'owner-b', body: { stateVersion: 0 } })).status, 404);
  assert.equal((await call(env, path, { method: 'DELETE', body: { stateVersion: 0 }, headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await call(env, path, { method: 'DELETE', body: { stateVersion: 0 }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await call({ DB: env.DB }, path, { method: 'DELETE', body: { stateVersion: 0 } })).status, 503);
  const malformed = [undefined, {}, null, [], 0, { stateVersion: -1 }, { stateVersion: 0.1 }, { stateVersion: '0' }, { stateVersion: Number.MAX_SAFE_INTEGER + 1 }, { stateVersion: 0, ownerId: 'owner-b' }, { stateVersion: 0, revision: 1 }];
  for (const body of malformed) {
    assert.equal((await call(env, path, { method: 'DELETE', body })).status, 400);
    assert.equal((await call(env, path + '/restore', { method: 'POST', body })).status, 400);
  }
  assert.equal((await call(env, path, { method: 'DELETE', body: { stateVersion: 0 }, headers: { 'Content-Type': 'text/plain' } })).status, 400);
  const badJSON = new Request(origin + '/api/records' + path, { method: 'DELETE', headers: { Origin: origin, 'oai-authenticated-user-id': owner, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await handleAPI(badJSON, env)).status, 400);
  const response = await call(env, path, { method: 'DELETE', body: { stateVersion: 0 } });
  assert.equal(response.status, 200);
  const deleted = await response.json();
  assert.equal(deleted.run.stateVersion, 1);
  assert.ok(deleted.run.deletedAt);
  assert.equal(deleted.record.runs.length, 1);
  assert.deepEqual((await (await call(env, `/${record.id}`)).json()).record.runs[0], deleted.run);
  assert.equal((await (await call(env, '')).json()).records[0].runCount, 0);
  assert.equal((await call(env, path + '/restore', { method: 'POST', body: { stateVersion: 0 } })).status, 409);
  const restored = await call(env, path + '/restore', { method: 'POST', body: { stateVersion: 1 } });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).run.deletedAt, null);
  assert.equal((await call(env, path, { method: 'POST', body: { stateVersion: 2 } })).status, 404);
  assert.equal((await call(env, path + '/restore', { method: 'DELETE', body: { stateVersion: 2 } })).status, 404);
  const current = await getRecord(env, owner, record.id);
  await updateRecord(env, owner, record.id, { revision: current.revision, status: 'archived' });
  assert.equal((await call(env, path, { method: 'DELETE', body: { stateVersion: 2 } })).status, 409);
  assert.equal((await call(env, path + '/restore', { method: 'POST', body: { stateVersion: 2 } })).status, 409);
});
