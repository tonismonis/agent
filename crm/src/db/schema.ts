import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

export const audit_log = pgTable('audit_log', {
  id: serial().primaryKey(),
  tool_name: text().notNull(),
  input: jsonb().notNull(),
  ok: boolean().notNull(),
  ts: timestamp({ withTimezone: true }).defaultNow(),
})

export const serviceUnit = pgEnum('service_unit', ['hour', 'flat'])

export const services = pgTable('services', {
  id: serial().primaryKey(),
  name: text().notNull(),
  price: integer().notNull(),
  unit: serviceUnit().notNull(),
  duration_minutes: integer(),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
  updated_at: timestamp({ withTimezone: true }).defaultNow(),
  deleted_at: timestamp({ withTimezone: true }),
})

export const clients = pgTable('clients', {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text(),
  phone: text(),
  notes: text(),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
  updated_at: timestamp({ withTimezone: true }).defaultNow(),
  deleted_at: timestamp({ withTimezone: true }),
})

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

export const appointments = pgTable('appointments', {
  id: serial().primaryKey(),
  client_id: integer()
    .notNull()
    .references(() => clients.id),
  service_id: integer()
    .notNull()
    .references(() => services.id),
  starts_at: timestamp({ withTimezone: true }).notNull(),
  ends_at: timestamp({ withTimezone: true }).notNull(),
  mode: appointmentMode().notNull(),
  status: appointmentStatus().notNull().default('scheduled'),
  // price snapshot at booking; services.price may change later
  price: integer().notNull(),
  notes: text(),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
  updated_at: timestamp({ withTimezone: true }).defaultNow(),
  deleted_at: timestamp({ withTimezone: true }),
})

export const payments = pgTable('payments', {
  id: serial().primaryKey(),
  client_id: integer()
    .notNull()
    .references(() => clients.id),
  appointment_id: integer().references(() => appointments.id),
  amount: integer().notNull(),
  paid_at: timestamp({ withTimezone: true }).notNull(),
  notes: text(),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
  updated_at: timestamp({ withTimezone: true }).defaultNow(),
  deleted_at: timestamp({ withTimezone: true }),
})
