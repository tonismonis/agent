import { beforeEach, expect, test } from 'vitest'
import { z } from 'zod'

import { db } from '#/db'
import { audit_log, clients, services } from '#/db/schema'
import {
  createClient,
  createService,
  findClients,
  findServices,
  softDeleteClient,
  softDeleteService,
  updateClient,
  updateService,
} from './tools'

beforeEach(async () => {
  await db.delete(audit_log)
  await db.delete(clients)
  await db.delete(services)
})

test('tool call writes audit_log row', async () => {
  const input = { name: 'Acme', notes: 'New client' }

  await createClient.execute(input)

  const rows = await db.select().from(audit_log)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual(
    expect.objectContaining({
      tool_name: 'createClient',
      input,
      ok: true,
    }),
  )
})

test('failed tool call writes audit row with ok=false', async () => {
  const input = {}

  // @ts-expect-error exercising runtime validation
  await expect(createClient.execute(input)).rejects.toBeInstanceOf(z.ZodError)

  const rows = await db.select().from(audit_log)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual(
    expect.objectContaining({
      tool_name: 'createClient',
      input,
      ok: false,
    }),
  )
})

test('createClient rejects input without name', async () => {
  // @ts-expect-error exercising runtime validation
  await expect(createClient.execute({})).rejects.toBeInstanceOf(z.ZodError)

  const stored = await db.select().from(clients)
  expect(stored).toHaveLength(0)
})

test('createClient then findClients returns the created client', async () => {
  await createClient.execute({ name: 'Acme' })

  const found = await findClients.execute({ query: 'Acme' })

  expect(found).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'Acme' })]),
  )
})

test('createService then findServices returns it', async () => {
  await createService.execute({ name: 'Consulting', price: 50000, unit: 'hour' })

  const found = await findServices.execute({ query: 'consult' })

  expect(found).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'Consulting', price: 50000, unit: 'hour' }),
    ]),
  )
})

test('updateService changes price', async () => {
  const created = await createService.execute({
    name: 'Consulting',
    price: 50000,
    unit: 'hour',
  })

  await updateService.execute({ id: created.id, price: 75000 })
  const [found] = await findServices.execute({ query: 'Consulting' })

  expect(found.price).toBe(75000)
  expect(found.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime())
})

test('updateClient changes fields and bumps updated_at', async () => {
  const created = await createClient.execute({ name: 'Acme', notes: 'Old' })

  await updateClient.execute({ id: created.id, name: 'Beta', notes: 'New' })
  const [found] = await findClients.execute({ query: 'Beta' })

  expect(found).toEqual(expect.objectContaining({ name: 'Beta', notes: 'New' }))
  expect(found.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime())
})

test('softDeleteService hides from findServices', async () => {
  const created = await createService.execute({
    name: 'Consulting',
    price: 50000,
    unit: 'hour',
  })

  await softDeleteService.execute({ id: created.id })
  const found = await findServices.execute({ query: 'Consulting' })

  expect(found).toEqual([])
})

test('softDeleteClient hides client from findClients', async () => {
  const created = await createClient.execute({ name: 'Acme' })

  await softDeleteClient.execute({ id: created.id })
  const found = await findClients.execute({ query: 'Acme' })

  expect(found).toEqual([])
})
