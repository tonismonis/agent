import { z } from 'zod'

export const SANTIAGO = 'America/Santiago'

const DATE = String.raw`(\d{4})-(\d{2})-(\d{2})`
const CLOCK = String.raw`T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?`
const ZONE = String.raw`(Z|[+-]\d{2}:\d{2})`
const pattern = new RegExp(`^${DATE}(?:${CLOCK}${ZONE}?)?$`)

/**
 * A point in time as the model writes it. With an offset or Z it is that
 * instant. Without one it is the Owner's clock time in America/Santiago.
 * The schema stays a plain string so code-mode stubs and the audit log keep
 * the text the model sent.
 */
export const timeInput = z
  .string()
  .regex(new RegExp(`^${DATE}${CLOCK}${ZONE}?$`))
  .describe(
    "ISO 8601. Without an offset it is the Owner's clock time in America/Santiago, e.g. 2026-10-01T17:00",
  )

/** A range bound for searches. A bare date means that whole Santiago day. */
export const rangeInput = z
  .string()
  .regex(pattern)
  .describe(
    'A date (2026-10-01) means that whole day in America/Santiago; otherwise ISO 8601, read as Santiago clock time when it has no offset',
  )

/** Half-open [start, end). */
export type Range = { start: Date | null; end: Date | null }

export class NonexistentClockTime extends Error {}

type Parsed = {
  /** The written fields read as if they were UTC. */
  wall: number
  hasClock: boolean
  zone: string | undefined
}

const minute = 60_000
const day = 24 * 60 * minute

function parse(value: string): Parsed {
  const match = pattern.exec(value)
  if (!match) throw new Error(`Not an ISO 8601 date or time: ${value}`)
  const [, year, month, date, hour, min, second, fraction, zone] = match
  const fields = [
    Number(year),
    Number(month) - 1,
    Number(date),
    Number(hour ?? 0),
    Number(min ?? 0),
    Number(second ?? 0),
    Number((fraction ?? '').padEnd(3, '0')),
  ] as const
  const wall = Date.UTC(...fields)
  const check = new Date(wall)
  const normalized = [
    check.getUTCFullYear(),
    check.getUTCMonth(),
    check.getUTCDate(),
    check.getUTCHours(),
    check.getUTCMinutes(),
    check.getUTCSeconds(),
    check.getUTCMilliseconds(),
  ]
  if (normalized.some((field, index) => field !== fields[index]))
    throw new Error(`Not a real date or time: ${value}`)
  return { wall, hasClock: hour !== undefined, zone }
}

function zoneOffset(zone: string) {
  if (zone === 'Z') return 0
  const sign = zone.startsWith('-') ? -1 : 1
  return sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * minute
}

const santiagoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: SANTIAGO,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

/** The Santiago wall clock at an instant, read as if it were UTC. */
function santiagoWall(instant: number) {
  const parts = Object.fromEntries(
    santiagoParts
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) +
    (((instant % 1000) + 1000) % 1000)
  )
}

/**
 * Every instant whose Santiago offset could put its wall clock at `wall`,
 * earliest first. Santiago changes offset at most once in any two days.
 */
function candidates(wall: number) {
  const offsets = new Set(
    [wall - day, wall, wall + day].map((probe) => santiagoWall(probe) - probe),
  )
  return [...offsets].map((offset) => wall - offset).sort((a, b) => a - b)
}

/**
 * - An offset or Z string is exactly that instant.
 * - An offsetless clock time is the instant whose Santiago wall clock reads
 *   it. In the repeated autumn hour the earlier instant wins.
 * - A clock time in the skipped spring hour throws NonexistentClockTime.
 */
export function toInstant(value: z.output<typeof timeInput>): Date {
  const { wall, zone } = parse(value)
  if (zone) return new Date(wall - zoneOffset(zone))
  const instant = candidates(wall).find((each) => santiagoWall(each) === wall)
  if (instant === undefined)
    throw new NonexistentClockTime(
      `${value} does not exist in America/Santiago: the clocks skip that hour for daylight saving. Ask the Owner for another time.`,
    )
  return new Date(instant)
}

const santiagoDate = (instant: number) => Math.floor(santiagoWall(instant) / day)

/** A bare date is the first instant of that Santiago day. */
export function rangeStart(value: z.output<typeof rangeInput>): Date {
  const { wall, hasClock } = parse(value)
  if (hasClock) return toInstant(value)
  const first = candidates(wall).find((each) => santiagoDate(each) === wall / day)
  if (first === undefined) throw new Error(`No start of day for ${value}`)
  return new Date(first)
}

/** Exclusive. A bare date is the first instant of the next Santiago day. */
export function rangeEnd(value: z.output<typeof rangeInput>): Date {
  const { wall, hasClock } = parse(value)
  if (hasClock) return toInstant(value)
  return rangeStart(new Date(wall + day).toISOString().slice(0, 10))
}

export function toRange(from?: string, to?: string): Range {
  return {
    start: from ? rangeStart(from) : null,
    end: to ? rangeEnd(to) : null,
  }
}

const dayFormat = new Intl.DateTimeFormat('es-CL', {
  timeZone: SANTIAGO,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

const clockFormat = new Intl.DateTimeFormat('es-CL', {
  timeZone: SANTIAGO,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function describeSantiagoDay(instant: Date) {
  const parts = Object.fromEntries(
    dayFormat.formatToParts(instant).map((part) => [part.type, part.value]),
  )
  return `${parts.weekday} ${parts.day} de ${parts.month}`
}

/** "jueves 1 de octubre, 17:00" */
export function describeSantiagoTime(instant: Date) {
  return `${describeSantiagoDay(instant)}, ${clockFormat.format(instant)}`
}

/** "jueves 1 de octubre, 17:00–18:00" */
export function describeSantiagoSpan(starts_at: Date, ends_at: Date) {
  const startDay = describeSantiagoDay(starts_at)
  if (startDay !== describeSantiagoDay(ends_at))
    return `${describeSantiagoTime(starts_at)} – ${describeSantiagoTime(ends_at)}`
  return `${startDay}, ${clockFormat.format(starts_at)}–${clockFormat.format(ends_at)}`
}
