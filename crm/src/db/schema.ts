import { sql } from 'drizzle-orm'
import {
  boolean,
  bigint,
  check,
  date,
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
  time,
  timestamp,
  unique,
  uniqueIndex,
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
    check('services_price_positive', sql`${table.price} > 0`),
    check('services_duration_positive', sql`${table.duration_minutes} > 0`),
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

/**
 * A weekly rule the Owner stated: the same client, service and clock time on
 * given weekdays between two dates. Its classes are ordinary appointments
 * carrying `series_id` and the rule date they fulfil.
 */
export const appointmentSeries = pgTable(
  'appointment_series',
  {
    id: serial().primaryKey(),
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    client_id: integer().notNull(),
    service_id: integer().notNull(),
    mode: appointmentMode().notNull(),
    duration_minutes: integer().notNull(),
    // Per-class price snapshot, as on appointments.
    price: integer().notNull(),
    starts_on: date({ mode: 'string' }).notNull(),
    ends_on: date({ mode: 'string' }).notNull(),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp({ withTimezone: true }),
  },
  (table) => [
    unique('appointment_series_id_owner_id_unique').on(table.id, table.owner_id),
    unique('appointment_series_id_client_id_owner_id_unique').on(
      table.id,
      table.client_id,
      table.owner_id,
    ),
    foreignKey({
      name: 'appointment_series_client_owner_fk',
      columns: [table.client_id, table.owner_id],
      foreignColumns: [clients.id, clients.owner_id],
    }),
    foreignKey({
      name: 'appointment_series_service_owner_fk',
      columns: [table.service_id, table.owner_id],
      foreignColumns: [services.id, services.owner_id],
    }),
    check('appointment_series_ends_on_or_after_start', sql`${table.ends_on} >= ${table.starts_on}`),
    check('appointment_series_duration_positive', sql`${table.duration_minutes} > 0`),
    check('appointment_series_price_nonnegative', sql`${table.price} >= 0`),
    ownerPolicy(),
  ],
).enableRLS()

/** The weekdays of a series and the clock time on each; 0 is Sunday, as extract(dow). */
export const appointmentSeriesDays = pgTable(
  'appointment_series_days',
  {
    series_id: integer().notNull(),
    owner_id: uuid()
      .notNull()
      .default(sql`nullif(current_setting('app.owner_id', true), '')::uuid`)
      .references(() => owners.id),
    weekday: integer().notNull(),
    starts_time: time().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.series_id, table.weekday] }),
    foreignKey({
      name: 'appointment_series_days_series_owner_fk',
      columns: [table.series_id, table.owner_id],
      foreignColumns: [appointmentSeries.id, appointmentSeries.owner_id],
    }),
    check('appointment_series_days_weekday_range', sql`${table.weekday} between 0 and 6`),
    ownerPolicy(),
  ],
).enableRLS()

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
    series_id: integer(),
    // The rule date this class fulfils; stays put when the class alone moves.
    series_date: date({ mode: 'string' }),
    series_weekday: integer().generatedAlwaysAs(
      sql`extract(dow from "series_date")::int`,
    ),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp({ withTimezone: true }),
  },
  // Drizzle has no exclusion-constraint builder; migration adds appointments_no_overlap.
  (table) => [
    unique('appointments_id_owner_id_unique').on(table.id, table.owner_id),
    unique('appointments_id_client_id_owner_id_unique').on(
      table.id,
      table.client_id,
      table.owner_id,
    ),
    check('appointments_ends_after_start', sql`${table.ends_at} > ${table.starts_at}`),
    check('appointments_price_nonnegative', sql`${table.price} >= 0`),
    check(
      'appointments_series_pair',
      sql`(${table.series_id} is null) = (${table.series_date} is null)`,
    ),
    uniqueIndex('appointments_series_date_unique')
      .on(table.series_id, table.series_date)
      .where(sql`${table.deleted_at} is null`),
    foreignKey({
      name: 'appointments_series_client_fk',
      columns: [table.series_id, table.client_id, table.owner_id],
      foreignColumns: [
        appointmentSeries.id,
        appointmentSeries.client_id,
        appointmentSeries.owner_id,
      ],
    }),
    foreignKey({
      name: 'appointments_series_day_fk',
      columns: [table.series_id, table.series_weekday],
      foreignColumns: [appointmentSeriesDays.series_id, appointmentSeriesDays.weekday],
    }),
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
    // A payment settles an appointment of the same client. MATCH SIMPLE skips
    // it when appointment_id is null.
    foreignKey({
      name: 'payments_appointment_client_fk',
      columns: [table.appointment_id, table.client_id, table.owner_id],
      foreignColumns: [
        appointments.id,
        appointments.client_id,
        appointments.owner_id,
      ],
    }),
    check('payments_amount_positive', sql`${table.amount} > 0`),
    ownerPolicy(),
  ],
).enableRLS()
