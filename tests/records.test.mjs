import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RecordError, ATTACHMENT_LIMITS, listRecords, createRecord, getRecord, updateRecord,
  addAttachment, getAttachment, removeAttachment, saveRun, addNote, serializeRecord,
} from '../src/records.js';

const migrations = new URL('../drizzle/', import.meta.url);
const sqlMigrations = () => readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()
  .map((name) => readFileSync(new URL(name, migrations), 'utf8'));

/** D1-shaped adapter; every prepared statement contains exactly one SQL operation. */
function databaseAdapter(sqlite) {
  const calls = [];
  function prepare(sql) {
    assert.ok(!sql.includes(';'), 'request persistence must prepare a single statement');
    assert.ok(!/\b(?:CREATE|DROP|ALTER)\b/i.test(sql), 'request persistence must not manage schema');
    const native = sqlite.prepare(sql);
    const statement = {
      sql, values: [],
      bind(...values) { this.values = values; calls.push({ sql, values }); return this; },
      async first() { return native.get(...this.values) ?? null; },
      async all() { return { results: native.all(...this.values), meta: { changes: 0 } }; },
      async run() { return { results: [], meta: { changes: Number(native.run(...this.values).changes) } }; },
      execute() {
        if (native.columns().length) return { results: native.all(...this.values), meta: { changes: 0 } };
        return { results: [], meta: { changes: Number(native.run(...this.values).changes) } };
      },
    };
    return statement;
  }
  return {
    calls, prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlMigrations().forEach((sql) => sqlite.exec(sql));
  const env = { DB: databaseAdapter(sqlite), BUCKET: { delete() { throw new Error('soft removal must preserve R2'); } } };
  t.after(() => sqlite.close());
  return { sqlite, env };
}

const rejectStatus = async (operation, status) => assert.rejects(operation, (error) => error instanceof RecordError && error.status === status);
const file = (overrides = {}) => ({ name: '合同.pdf', mime: 'application/pdf', size: 1024, sha256: 'a'.repeat(64), objectKey: `private/${crypto.randomUUID()}`, ...overrides });
const snapshot = (record, overrides = {}) => ({ revision: record.revision, inputSnapshot: record.input, attachmentIds: [], plan: { strategy: '核对资料及付款条件。' }, ...overrides });

test('empty database has no seeded cases; incomplete drafts and parameterized literal search persist', async (t) => {
  const { env } = fixture(t);
  assert.deepEqual(await listRecords(env, 'owner-a'), []);
  const draft = await createRecord(env, 'owner-a');
  assert.equal(draft.revision, 1);
  assert.deepEqual(draft.input, {});
  assert.deepEqual(draft.attachments, []);
  assert.deepEqual(draft.runs, []);
  assert.deepEqual(draft.notes, []);
  assert.match(draft.id, /^[0-9a-f-]{36}$/);
  assert.match(draft.number, /^RC-\d{8}-[0-9A-F]{8}$/);
  const value = await updateRecord(env, 'owner-a', draft.id, {
    revision: 1, title: "客户100%_待办 ' OR 1=1 --", input: { debtorName: '甲公司', amount: null, dueDate: '', issueText: '' },
  });
  assert.equal(value.revision, 2);
  assert.equal((await listRecords(env, 'owner-a', { query: '100%_' })).length, 1);
  assert.equal((await listRecords(env, 'owner-a', { query: "' OR 1=1 --" })).length, 1);
  assert.equal((await listRecords(env, 'owner-a', { query: '不存在%' })).length, 0);
  assert.equal((await listRecords(env, 'owner-a', { query: '甲公司' }))[0].amount, null);
  assert.ok(env.DB.calls.some(({ values }) => values.includes("客户100%_待办 ' OR 1=1 --")));
});

test('owner is mandatory before DB access and arbitrary identity, credential, or endpoint fields are rejected', async (t) => {
  const { env } = fixture(t);
  const operations = [
    () => listRecords(env, ''), () => createRecord(env, null), () => getRecord(env, undefined, 'case'),
    () => updateRecord(env, '', 'case', {}), () => addAttachment(env, '', 'case', {}),
    () => getAttachment(env, '', 'case', 'file'), () => removeAttachment(env, '', 'case', 'file'),
    () => saveRun(env, '', 'case', {}), () => addNote(env, '', 'case', {}),
  ];
  for (const operation of operations) await rejectStatus(operation, 401);
  assert.equal(env.DB.calls.length, 0);
  await rejectStatus(() => createRecord(env, 'owner-a', { ownerId: 'owner-b' }), 400);
  for (const key of ['ownerId', 'apiKey', 'key', 'endpoint', 'model', '__proto__']) {
    const input = JSON.parse(`{"${key}":"injected"}`);
    await rejectStatus(() => createRecord(env, 'owner-a', { input }), 400);
  }
  await rejectStatus(() => createRecord(env, 'owner-a', { title: '名'.repeat(121) }), 400);
  await rejectStatus(() => createRecord(env, 'owner-a', { input: { issueText: '字'.repeat(6001) } }), 400);
  await rejectStatus(() => createRecord(env, 'owner-a', { input: { amount: '3000' } }), 400);
  await rejectStatus(() => createRecord(env, 'owner-a', { input: { amount: Infinity } }), 400);
  await rejectStatus(() => createRecord(env, 'owner-a', { input: { dueDate: '2026-02-30' } }), 400);
  await rejectStatus(() => createRecord(env, 'owner-a', { input: { evidence: ['invented'] } }), 400);
  assert.equal((await listRecords(env, 'owner-a')).length, 0);
  for (const amount of ['', 0, -1, 12.345]) {
    assert.equal((await createRecord(env, 'owner-a', { input: { amount } })).input.amount, amount);
  }
});

test('two owners and two cases isolate fields, attachments, generated runs and notes', async (t) => {
  const { env, sqlite } = fixture(t);
  const a = await createRecord(env, 'owner-a', { title: '甲案', input: { debtorName: '甲债务人', amount: 100 } });
  const a2 = await createRecord(env, 'owner-a', { title: '乙案', input: { debtorName: '乙债务人', amount: 200 } });
  const b = await createRecord(env, 'owner-b', { title: '私有案', input: { debtorName: '私人债务人' } });
  const aFile = await addAttachment(env, 'owner-a', a.id, file());
  const a2File = await addAttachment(env, 'owner-a', a2.id, file());
  const bFile = await addAttachment(env, 'owner-b', b.id, file());
  assert.equal(aFile.name, a2File.name);
  assert.notEqual(aFile.id, a2File.id);
  assert.equal(aFile.objectKey, undefined);
  assert.ok((await getAttachment(env, 'owner-a', a.id, aFile.id)).objectKey);
  for (const operation of [
    () => getRecord(env, 'owner-b', a.id),
    () => updateRecord(env, 'owner-b', a.id, { revision: 2, title: '越权' }),
    () => addAttachment(env, 'owner-b', a.id, file()),
    () => addNote(env, 'owner-b', a.id, { body: '越权' }),
    () => saveRun(env, 'owner-b', a.id, snapshot(a)),
    () => getAttachment(env, 'owner-b', a.id, aFile.id),
    () => getAttachment(env, 'owner-a', a.id, a2File.id),
    () => getAttachment(env, 'owner-a', a.id, bFile.id),
    () => removeAttachment(env, 'owner-b', a.id, aFile.id),
    () => removeAttachment(env, 'owner-a', a.id, a2File.id),
    () => saveRun(env, 'owner-a', a.id, snapshot(a, { attachmentIds: [a2File.id] })),
    () => saveRun(env, 'owner-a', a.id, snapshot(a, { attachmentIds: [bFile.id] })),
    () => saveRun(env, 'owner-a', a.id, snapshot(a, { attachmentIds: ['missing'] })),
  ]) await rejectStatus(operation, 404);
  const runA = await saveRun(env, 'owner-a', a.id, snapshot(await getRecord(env, 'owner-a', a.id), { attachmentIds: [aFile.id] }));
  const runB = await saveRun(env, 'owner-b', b.id, snapshot(await getRecord(env, 'owner-b', b.id), { attachmentIds: [bFile.id] }));
  const noteA = await addNote(env, 'owner-a', a.id, { body: '甲案跟进' });
  assert.deepEqual((await getRecord(env, 'owner-a', a.id)).runs.map(({ id }) => id), [runA.id]);
  assert.ok(!JSON.stringify(await getRecord(env, 'owner-a', a.id)).includes('private/'));
  assert.deepEqual((await getRecord(env, 'owner-a', a2.id)).runs, []);
  assert.deepEqual((await getRecord(env, 'owner-b', b.id)).runs.map(({ id }) => id), [runB.id]);
  assert.deepEqual((await getRecord(env, 'owner-a', a2.id)).notes, []);
  assert.equal((await getRecord(env, 'owner-a', a.id)).notes[0].id, noteA.id);
  assert.equal((await listRecords(env, 'owner-a')).length, 2);
  assert.equal((await listRecords(env, 'owner-b')).length, 1);
  assert.equal((await getRecord(env, 'owner-a', a.id)).input.debtorName, '甲债务人');
  assert.equal((await getRecord(env, 'owner-a', a2.id)).input.debtorName, '乙债务人');
  assert.throws(() => sqlite.prepare(`INSERT INTO recovery_notes (id, owner_id, record_id, body, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), 'owner-b', a.id, 'invalid parent', new Date().toISOString()), /FOREIGN KEY/);
});

test('optimistic locking and simultaneous attachment writes preserve monotonic revisions', async (t) => {
  const { env } = fixture(t);
  const record = await createRecord(env, 'owner-a');
  await rejectStatus(() => updateRecord(env, 'owner-a', record.id, { title: '缺少版本' }), 400);
  const writes = await Promise.allSettled([
    updateRecord(env, 'owner-a', record.id, { revision: 1, title: '会话一' }),
    updateRecord(env, 'owner-a', record.id, { revision: 1, title: '会话二' }),
  ]);
  assert.equal(writes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(writes.find(({ status }) => status === 'rejected').reason.status, 409);
  const saved = await getRecord(env, 'owner-a', record.id);
  assert.equal(saved.revision, 2);
  await Promise.all([addAttachment(env, 'owner-a', record.id, file()), addAttachment(env, 'owner-a', record.id, file())]);
  assert.equal((await getRecord(env, 'owner-a', record.id)).revision, 4);
  await rejectStatus(() => updateRecord(env, 'owner-a', record.id, { revision: saved.revision, input: { debtorName: '旧窗口' } }), 409);
  assert.equal((await getRecord(env, 'owner-a', record.id)).title, saved.title);
});

test('concurrent count and byte quotas are atomic, and removal frees quota without deleting blobs', async (t) => {
  const { env, sqlite } = fixture(t);
  const a = await createRecord(env, 'owner-a');
  for (let index = 0; index < 7; index += 1) await addAttachment(env, 'owner-a', a.id, file());
  const writes = await Promise.allSettled([addAttachment(env, 'owner-a', a.id, file()), addAttachment(env, 'owner-a', a.id, file())]);
  assert.equal(writes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(writes.find(({ status }) => status === 'rejected').reason.status, 413);
  let current = await getRecord(env, 'owner-a', a.id);
  assert.equal(current.attachments.length, 8);
  assert.equal(current.revision, 9);
  const removed = current.attachments[0];
  current = await removeAttachment(env, 'owner-a', a.id, removed.id);
  assert.equal(current.revision, 10);
  assert.equal(current.attachments.length, 7);
  await rejectStatus(() => getAttachment(env, 'owner-a', a.id, removed.id), 404);
  await rejectStatus(() => removeAttachment(env, 'owner-a', a.id, removed.id), 404);
  assert.equal((await getRecord(env, 'owner-a', a.id)).revision, 10);
  assert.ok(sqlite.prepare('SELECT removed_at FROM recovery_attachments WHERE owner_id = ? AND record_id = ? AND id = ?').get('owner-a', a.id, removed.id).removed_at);
  await addAttachment(env, 'owner-a', a.id, file());
  const b = await createRecord(env, 'owner-a');
  for (let index = 0; index < 3; index += 1) await addAttachment(env, 'owner-a', b.id, file({ size: ATTACHMENT_LIMITS.fileBytes }));
  const byteWrites = await Promise.allSettled([
    addAttachment(env, 'owner-a', b.id, file({ size: 1024 * 1024 })),
    addAttachment(env, 'owner-a', b.id, file({ size: 1024 * 1024 })),
  ]);
  assert.equal(byteWrites.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(byteWrites.find(({ status }) => status === 'rejected').reason.status, 413);
  assert.equal((await getRecord(env, 'owner-a', b.id)).attachments.reduce((sum, value) => sum + value.size, 0), ATTACHMENT_LIMITS.totalBytes);
  await rejectStatus(() => addAttachment(env, 'owner-a', b.id, file({ size: ATTACHMENT_LIMITS.fileBytes + 1 })), 413);
});

test('generation retains immutable input and attachment snapshots across edits, case switches, and soft removal', async (t) => {
  const { env } = fixture(t);
  const a = await createRecord(env, 'owner-a', { input: { debtorName: '原债务人', amount: 100 } });
  const b = await createRecord(env, 'owner-a', { input: { debtorName: '当前另案', amount: 200 } });
  const uploaded = await addAttachment(env, 'owner-a', a.id, file());
  const original = await getRecord(env, 'owner-a', a.id);
  const inFlight = snapshot(original, { attachmentIds: [uploaded.id], materialSummary: [{ id: uploaded.id, text: '用户提交资料待核验' }] });
  await updateRecord(env, 'owner-a', a.id, { revision: original.revision, input: { debtorName: '编辑后债务人', amount: 300 } });
  await removeAttachment(env, 'owner-a', a.id, uploaded.id);
  const first = await saveRun(env, 'owner-a', a.id, inFlight);
  assert.equal(first.revision, original.revision);
  assert.equal(first.snapshotStale, true);
  assert.deepEqual(first.inputSnapshot, original.input);
  assert.deepEqual(first.attachmentIds, [uploaded.id]);
  inFlight.inputSnapshot.debtorName = '调用方对象后来变动';
  inFlight.plan.strategy = '后来变动';
  const current = await getRecord(env, 'owner-a', a.id);
  assert.equal(current.input.debtorName, '编辑后债务人');
  assert.equal(current.runs[0].inputSnapshot.debtorName, '原债务人');
  assert.equal(current.runs[0].plan.strategy, '核对资料及付款条件。');
  assert.equal((await getRecord(env, 'owner-a', b.id)).input.debtorName, '当前另案');
  assert.equal((await getRecord(env, 'owner-a', b.id)).runs.length, 0);
  const second = await saveRun(env, 'owner-a', a.id, snapshot(current, {
    materialSummary: [{ name: '内部附件', objectKey: 'private/secret', nested: { object_key: 'private/other', text: '待核查' } }],
  }));
  assert.equal(second.snapshotStale, false);
  assert.deepEqual(second.materialSummary, [{ name: '内部附件', nested: { text: '待核查' } }]);
  assert.equal((await getRecord(env, 'owner-a', a.id)).revision, current.revision);
  await rejectStatus(() => saveRun(env, 'owner-a', a.id, snapshot(current, { revision: current.revision + 10 })), 409);
  assert.equal((await getRecord(env, 'owner-a', a.id)).runs.length, 2);
  assert.equal((await listRecords(env, 'owner-a')).find(({ id }) => id === a.id).runCount, 2);
});

test('archiving preserves history, accepts completion of in-flight runs and denies new notes or attachments', async (t) => {
  const { env } = fixture(t);
  const a = await createRecord(env, 'owner-a', { title: '可归档案' });
  await addNote(env, 'owner-a', a.id, { body: '第一次跟进' });
  await saveRun(env, 'owner-a', a.id, snapshot(a));
  const archived = await updateRecord(env, 'owner-a', a.id, { revision: 1, status: 'archived' });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.notes.length, 1);
  assert.equal(archived.runs.length, 1);
  assert.equal((await listRecords(env, 'owner-a', { status: 'active' })).length, 0);
  assert.equal((await listRecords(env, 'owner-a', { status: 'archived' })).length, 1);
  await rejectStatus(() => addAttachment(env, 'owner-a', a.id, file()), 404);
  await rejectStatus(() => addNote(env, 'owner-a', a.id, { body: '归档后' }), 404);
  // The API checks active status before starting an analysis. Persistence must
  // retain its result if the user archives the parent while the model is running.
  const completed = await saveRun(env, 'owner-a', a.id, snapshot(a));
  assert.equal(completed.snapshotStale, true);
  const afterCompletion = await getRecord(env, 'owner-a', a.id);
  assert.equal(afterCompletion.status, 'archived');
  assert.equal(afterCompletion.revision, archived.revision);
  assert.deepEqual(afterCompletion.input, archived.input);
  assert.equal(afterCompletion.runs.length, 2);
  await rejectStatus(() => addNote(env, 'owner-a', a.id, { body: '字'.repeat(4001) }), 400);
  const restored = await updateRecord(env, 'owner-a', a.id, { revision: archived.revision, status: 'active' });
  await addNote(env, 'owner-a', a.id, { body: '恢复后的跟进' });
  assert.equal((await getRecord(env, 'owner-a', a.id)).notes.length, 2);
  assert.equal(restored.revision, 3);
  assert.deepEqual(serializeRecord({ ...restored, attachments: [{ id: 'a', objectKey: 'secret' }] }).attachments, [{ id: 'a' }]);
});

test('file-backed database reopens with cases, attachment metadata, complete runs and notes intact', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-records-test-'));
  const filePath = join(directory, 'records.sqlite');
  let sqlite = new DatabaseSync(filePath);
  t.after(() => {
    sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${filePath}${suffix}`, { force: true });
    rmdirSync(directory);
  });
  sqlMigrations().forEach((sql) => sqlite.exec(sql));
  let env = { DB: databaseAdapter(sqlite) };
  const a = await createRecord(env, 'owner-a', { title: '持久化案件', input: { debtorName: '持久化付款方', amount: 88 } });
  const uploaded = await addAttachment(env, 'owner-a', a.id, file());
  await addNote(env, 'owner-a', a.id, { body: '下周再次核对' });
  const current = await getRecord(env, 'owner-a', a.id);
  await saveRun(env, 'owner-a', a.id, snapshot(current, { attachmentIds: [uploaded.id] }));
  const before = await getRecord(env, 'owner-a', a.id);
  sqlite.close();
  sqlite = new DatabaseSync(filePath);
  env = { DB: databaseAdapter(sqlite) };
  assert.deepEqual(await getRecord(env, 'owner-a', a.id), before);
  assert.equal((await listRecords(env, 'owner-a'))[0].attachmentCount, 1);
  assert.deepEqual(await listRecords(env, 'owner-b'), []);
});
