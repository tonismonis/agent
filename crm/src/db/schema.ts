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
