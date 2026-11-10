import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const recoveryRecords = sqliteTable('recovery_records', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  number: text('number').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull().default('active'),
  revision: integer('revision').notNull().default(1),
  inputJson: text('input_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('recovery_records_owner_id_unique').on(table.ownerId, table.id),
  uniqueIndex('recovery_records_owner_number_unique').on(table.ownerId, table.number),
  index('recovery_records_owner_status_updated_idx').on(table.ownerId, table.status, table.updatedAt),
  check('recovery_records_status_check', sql`${table.status} IN ('active', 'archived')`),
  check('recovery_records_revision_check', sql`${table.revision} >= 1`),
  check('recovery_records_input_json_check', sql`json_valid(${table.inputJson})`),
]);

export const recoveryAttachments = sqliteTable('recovery_attachments', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  recordId: text('record_id').notNull(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  objectKey: text('object_key').notNull(),
  createdAt: text('created_at').notNull(),
  removedAt: text('removed_at'),
}, (table) => [
  foreignKey({ columns: [table.ownerId, table.recordId], foreignColumns: [recoveryRecords.ownerId, recoveryRecords.id], name: 'recovery_attachments_parent_fk' }),
  uniqueIndex('recovery_attachments_owner_record_id_unique').on(table.ownerId, table.recordId, table.id),
  uniqueIndex('recovery_attachments_object_key_unique').on(table.objectKey),
  index('recovery_attachments_owner_record_active_idx').on(table.ownerId, table.recordId, table.removedAt),
  check('recovery_attachments_size_check', sql`${table.size} > 0 AND ${table.size} <= 5242880`),
]);

export const recoveryRuns = sqliteTable('recovery_runs', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  recordId: text('record_id').notNull(),
  revision: integer('revision').notNull(),
  inputJson: text('input_json').notNull(),
  attachmentIdsJson: text('attachment_ids_json').notNull().default('[]'),
  planJson: text('plan_json').notNull(),
  materialSummaryJson: text('material_summary_json').notNull().default('null'),
  snapshotStale: integer('snapshot_stale', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => [
  foreignKey({ columns: [table.ownerId, table.recordId], foreignColumns: [recoveryRecords.ownerId, recoveryRecords.id], name: 'recovery_runs_parent_fk' }),
  uniqueIndex('recovery_runs_owner_record_id_unique').on(table.ownerId, table.recordId, table.id),
  index('recovery_runs_owner_record_created_idx').on(table.ownerId, table.recordId, table.createdAt),
  check('recovery_runs_revision_check', sql`${table.revision} >= 1`),
  check('recovery_runs_input_json_check', sql`json_valid(${table.inputJson})`),
  check('recovery_runs_attachments_json_check', sql`json_valid(${table.attachmentIdsJson})`),
  check('recovery_runs_plan_json_check', sql`json_valid(${table.planJson})`),
  check('recovery_runs_material_json_check', sql`json_valid(${table.materialSummaryJson})`),
]);

export const recoveryNotes = sqliteTable('recovery_notes', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  recordId: text('record_id').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  foreignKey({ columns: [table.ownerId, table.recordId], foreignColumns: [recoveryRecords.ownerId, recoveryRecords.id], name: 'recovery_notes_parent_fk' }),
  uniqueIndex('recovery_notes_owner_record_id_unique').on(table.ownerId, table.recordId, table.id),
  index('recovery_notes_owner_record_created_idx').on(table.ownerId, table.recordId, table.createdAt),
]);
