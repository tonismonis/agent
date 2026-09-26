import { sql } from 'drizzle-orm'
import {
  boolean,
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import type { ModelMessage, TokenUsage } from '@tanstack/ai'
import type { RunStatus } from '@tanstack/ai-persistence'

export const appRole = pgRole('crm_app', {
  createDb: false,
  createRole: false,
  inherit: false,
})

const ownerPolicy = () =>
  pgPolicy('owner_isolation', {
    to: appRole,
    using: sql`owner_id = current_setting('app.owner_id')::uuid`,
    withCheck: sql`owner_id = current_setting('app.owner_id')::uuid`,
  })

export const owners = pgTable('owners', {
  id: uuid().defaultRandom().primaryKey(),
  external_id: text().unique(),
  email: text().notNull().unique(),
  name: text().notNull(),
  profession: text().notNull(),
  restricted_notes: boolean().notNull().default(false),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export const audit_log = pgTable(
  'audit_log',
  {
    id: serial().primaryKey(),
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    tool_name: text().notNull(),
    input: jsonb().notNull(),
    entity: text().notNull(),
    entity_id: integer(),
    before: jsonb(),
    ok: boolean().notNull(),
    error: text(),
    ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy('owner_select', {
      for: 'select',
      to: appRole,
      using: sql`owner_id = current_setting('app.owner_id')::uuid`,
    }),
    pgPolicy('owner_insert', {
      for: 'insert',
      to: appRole,
      withCheck: sql`owner_id = current_setting('app.owner_id')::uuid`,
    }),
  ],
).enableRLS()

export const messages = pgTable(
  'messages',
  {
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    thread_id: text().notNull(),
    messages_json: jsonb().$type<Array<ModelMessage>>().notNull(),
    updated_at: bigint({ mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.owner_id, table.thread_id] }),
    ownerPolicy(),
  ],
).enableRLS()

export const runs = pgTable(
  'runs',
  {
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    run_id: text().notNull(),
    thread_id: text().notNull(),
    status: text().$type<RunStatus>().notNull(),
    started_at: bigint({ mode: 'number' }).notNull(),
    finished_at: bigint({ mode: 'number' }),
    error: text(),
    usage_json: jsonb().$type<TokenUsage>(),
  },
  (table) => [
    primaryKey({ columns: [table.owner_id, table.run_id] }),
    index('runs_owner_started_at_idx').on(table.owner_id, table.started_at),
    ownerPolicy(),
  ],
).enableRLS()

export const serviceUnit = pgEnum('service_unit', ['hour', 'flat'])

export const services = pgTable(
  'services',
  {
    id: serial().primaryKey(),
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    name: text().notNull(),
    price: integer().notNull(),
    unit: serviceUnit().notNull(),
    duration_minutes: integer(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    unique('services_id_owner_id_unique').on(table.id, table.owner_id),
    ownerPolicy(),
  ],
).enableRLS()

export const clients = pgTable(
  'clients',
  {
    id: serial().primaryKey(),
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    name: text().notNull(),
    email: text(),
    phone: text(),
    notes: text(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    unique('clients_id_owner_id_unique').on(table.id, table.owner_id),
    ownerPolicy(),
  ],
).enableRLS()

export const appointmentMode = pgEnum('appointment_mode', [
  'online',
  'in_person',
])

export const appointmentStatus = pgEnum('appointment_status', [
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
])

export const appointments = pgTable(
  'appointments',
  {
    id: serial().primaryKey(),
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    client_id: integer().notNull(),
    service_id: integer().notNull(),
    starts_at: timestamp({ withTimezone: true }).notNull(),
    ends_at: timestamp({ withTimezone: true }).notNull(),
    mode: appointmentMode().notNull(),
    status: appointmentStatus().notNull().default('scheduled'),
    // Price snapshot at creation; Services.price may change later.
    price: integer().notNull(),
    notes: text(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp({ withTimezone: true }),
  },
  // Drizzle has no exclusion-constraint builder; migration adds appointments_no_overlap.
  (table) => [
    unique('appointments_id_owner_id_unique').on(table.id, table.owner_id),
    foreignKey({
      name: 'appointments_client_owner_fk',
      columns: [table.client_id, table.owner_id],
      foreignColumns: [clients.id, clients.owner_id],
    }),
    foreignKey({
      name: 'appointments_service_owner_fk',
      columns: [table.service_id, table.owner_id],
      foreignColumns: [services.id, services.owner_id],
    }),
    ownerPolicy(),
  ],
).enableRLS()

export const payments = pgTable(
  'payments',
  {
    id: serial().primaryKey(),
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    client_id: integer().notNull(),
    appointment_id: integer(),
    amount: integer().notNull(),
    paid_at: timestamp({ withTimezone: true }).notNull(),
    notes: text(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    unique('payments_id_owner_id_unique').on(table.id, table.owner_id),
    foreignKey({
      name: 'payments_client_owner_fk',
      columns: [table.client_id, table.owner_id],
      foreignColumns: [clients.id, clients.owner_id],
    }),
    foreignKey({
      name: 'payments_appointment_owner_fk',
      columns: [table.appointment_id, table.owner_id],
      foreignColumns: [appointments.id, appointments.owner_id],
    }),
    ownerPolicy(),
  ],
).enableRLS()
