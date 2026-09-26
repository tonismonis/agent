import { z } from 'zod'

export const SANTIAGO = 'America/Santiago'

const DATE = String.raw`(\d{4})-(\d{2})-(\d{2})`
const CLOCK = String.raw`T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?`
const ZONE = String.raw`(Z|[+-]\d{2}:\d{2})`
const pattern = new RegExp(`^${DATE}(?:${CLOCK}${ZONE}?)?$`)

function isRealDate(value: string) {
  const [year, month, date] = value.slice(0, 10).split('-').map(Number)
  const check = new Date(Date.UTC(year!, month! - 1, date))
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month! - 1 &&
    check.getUTCDate() === date
  )
}

/** A Santiago calendar date, `2026-11-17`. Never an instant. */
export const localDate = z
  .string()
  .regex(new RegExp(`^${DATE}$`))
  .refine(isRealDate, 'Not a real date')
  .brand<'LocalDate'>()
export type LocalDate = z.output<typeof localDate>

/** A Santiago wall-clock time, 24h: `17:00`. */
export const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .brand<'Clock'>()
export type Clock = z.output<typeof clock>

/** Indexed by Postgres' `extract(dow …)`: 0 is Sunday. */
export const weekdays = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const
export type Weekday = (typeof weekdays)[number]

/**
 * A point in time as the model writes it. With an offset or Z it is that
 * instant. Without one it is the Owner's clock time in America/Santiago.
 * The schema stays a plain string so code-mode stubs and the audit log keep
 * the text the model sent.
 */
export const timeInput = z
  .string()
  .regex(new RegExp(`^${DATE}${CLOCK}${ZONE}?$`))
  .refine(isRealDate, 'Not a real date')
  .describe(
    "ISO 8601. Without an offset it is the Owner's clock time in America/Santiago, e.g. 2026-10-01T17:00",
  )

/** A range bound for searches. A bare date means that whole Santiago day. */
export const rangeInput = z
  .string()
  .regex(pattern)
  .refine(isRealDate, 'Not a real date')
  .describe(
    'A date (2026-10-01) means that whole day in America/Santiago; otherwise ISO 8601, read as Santiago clock time when it has no offset',
  )

/** A moment the Owner may give as a day only, like when money came in. */
export const dateOrTimeInput = z
  .string()
  .regex(pattern)
  .refine(isRealDate, 'Not a real date')
  .describe(
    'A date (2026-10-01) means the start of that day in America/Santiago; otherwise ISO 8601, read as Santiago clock time when it has no offset',
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
  const instant = wallInstant(wall)
  if (instant === null)
    throw new NonexistentClockTime(
      `${value} does not exist in America/Santiago: the clocks skip that hour for daylight saving`,
    )
  return instant
}

/** The earlier instant whose Santiago wall clock reads `wall`; null in the spring gap. */
function wallInstant(wall: number) {
  const instant = candidates(wall).find((each) => santiagoWall(each) === wall)
  return instant === undefined ? null : new Date(instant)
}

function dateWall(date: LocalDate) {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year!, month! - 1, day)
}

function clockMinutes(time: Clock) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours! * 60 + minutes!
}

/** The instant the Owner means by `date time`; null when that hour is skipped. */
export function localInstant(date: LocalDate, time: Clock): Date | null {
  return wallInstant(dateWall(date) + clockMinutes(time) * minute)
}

export function santiagoDateOf(instant: Date): LocalDate {
  // SAFETY: an ISO string's first ten characters are a real YYYY-MM-DD date.
  return new Date(santiagoWall(instant.getTime())).toISOString().slice(0, 10) as LocalDate
}

export function santiagoClockOf(instant: Date): Clock {
  // SAFETY: characters 11–16 of an ISO string are a 24h HH:MM clock.
  return new Date(santiagoWall(instant.getTime())).toISOString().slice(11, 16) as Clock
}

/** Calendar arithmetic on the date itself, so a clock change can't shift it. */
export function addDays(date: LocalDate, days: number): LocalDate {
  // SAFETY: an ISO string's first ten characters are a real YYYY-MM-DD date.
  return new Date(dateWall(date) + days * day).toISOString().slice(0, 10) as LocalDate
}

export function weekdayOf(date: LocalDate): Weekday {
  return weekdays[new Date(dateWall(date)).getUTCDay()]!
}

/**
 * A time the model wrote, as the Owner would name it. `instant` is null when
 * the clock time falls in the skipped spring hour.
 */
export function resolveTime(value: z.output<typeof timeInput>) {
  const { wall, zone } = parse(value)
  if (zone) {
    const instant = new Date(wall - zoneOffset(zone))
    return {
      date: santiagoDateOf(instant),
      time: santiagoClockOf(instant),
      instant,
    }
  }
  const at = new Date(wall).toISOString()
  return {
    // SAFETY: an ISO string's first ten characters are a real YYYY-MM-DD date.
    date: at.slice(0, 10) as LocalDate,
    // SAFETY: characters 11–16 of an ISO string are a 24h HH:MM clock.
    time: at.slice(11, 16) as Clock,
    instant: wallInstant(wall),
  }
}

const santiagoDate = (instant: number) => Math.floor(santiagoWall(instant) / day)

/** A bare date is the first instant of that Santiago day; otherwise toInstant. */
export function startOf(value: z.output<typeof dateOrTimeInput>): Date {
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
  return startOf(new Date(wall + day).toISOString().slice(0, 10))
}

export function toRange(from?: string, to?: string): Range {
  return {
    start: from ? startOf(from) : null,
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

const calendarDayFormat = new Intl.DateTimeFormat('es-CL', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

function spokenDay(format: Intl.DateTimeFormat, instant: Date) {
  const parts = Object.fromEntries(
    format.formatToParts(instant).map((part) => [part.type, part.value]),
  )
  return `${parts.weekday} ${parts.day} de ${parts.month}`
}

function describeSantiagoDay(instant: Date) {
  return spokenDay(dayFormat, instant)
}

/** "domingo 6 de septiembre", read off the date itself, so it exists even in a DST gap. */
export function describeLocalDay(date: LocalDate) {
  return spokenDay(calendarDayFormat, new Date(dateWall(date)))
}

/** "17 de noviembre" */
export function describeLocalDate(date: LocalDate) {
  return describeLocalDay(date).replace(/^\S+ /, '')
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
