/**
 * The weekly rule of a series as calendar arithmetic. Dates step on Santiago
 * calendar dates and each class resolves its own clock time, so a 17:00 class
 * stays 17:00 across a clock change. Pure: no database.
 */

import { MAX_SERIES_CLASSES, MAX_SERIES_DAYS, refuse } from '#/lib/refusal'
import {
  addDays,
  describeLocalDate,
  localInstant,
  getWeekday,
  weekdays,
  type Clock,
  type LocalDate,
  type Weekday,
} from '#/lib/santiago-time'

export type WeeklySlot = { day: Weekday; time: Clock }

export type SeriesEnd = { until: LocalDate } | { count: number }

/** A class the rule asks for. `span` is null when its clock time is skipped that day. */
export type Occurrence = {
  date: LocalDate
  time: Clock
  span: { starts_at: Date; ends_at: Date } | null
}

const day = 24 * 60 * 60_000

function daysBetween(from: LocalDate, to: LocalDate) {
  return Math.round((Date.parse(to) - Date.parse(from)) / day)
}

/** The instant span of one class, or null inside the spring gap. */
export function buildOccurrence(
  date: LocalDate,
  time: Clock,
  minutes: number,
): Occurrence {
  const starts_at = localInstant(date, time)
  return {
    date,
    time,
    span: starts_at && {
      starts_at,
      ends_at: new Date(starts_at.getTime() + minutes * 60_000),
    },
  }
}

/**
 * Every class from `from` until the end, leaving out `skip`. A count counts
 * booked classes, so skipped dates push the end out. Past 104 classes or a
 * year it asks the Owner for a nearer end.
 */
export function planSeries(
  weekly: ReadonlyArray<WeeklySlot>,
  minutes: number,
  from: LocalDate,
  end: SeriesEnd,
  skip: ReadonlyArray<LocalDate>,
) {
  if ('until' in end && daysBetween(from, end.until) >= MAX_SERIES_DAYS)
    throw refuse.askShorter()
  const skipped = new Set(skip)
  const occurrences: Array<Occurrence> = []
  for (let date = from; ; date = addDays(date, 1)) {
    if ('until' in end && date > end.until) break
    if ('count' in end && occurrences.length >= end.count) break
    if (daysBetween(from, date) >= MAX_SERIES_DAYS) throw refuse.askShorter()
    const slot = weekly.find((each) => each.day === getWeekday(date))
    if (slot && !skipped.has(date))
      occurrences.push(buildOccurrence(date, slot.time, minutes))
    if (occurrences.length > MAX_SERIES_CLASSES) throw refuse.askShorter()
  }
  const last = occurrences.at(-1)
  return {
    occurrences,
    ends_on: 'until' in end ? end.until : (last?.date ?? from),
  }
}

const plural = new Map<Weekday, string>([
  ['sunday', 'domingos'],
  ['monday', 'lunes'],
  ['tuesday', 'martes'],
  ['wednesday', 'miércoles'],
  ['thursday', 'jueves'],
  ['friday', 'viernes'],
  ['saturday', 'sábados'],
])

/** Monday first, the way the Owner lists a week. */
export function inWeekOrder(weekly: ReadonlyArray<WeeklySlot>) {
  const order = (slot: WeeklySlot) => (weekdays.indexOf(slot.day) + 6) % 7
  return [...weekly].sort((a, b) => order(a) - order(b))
}

/** "todos los martes a las 17:00 y los jueves a las 18:00" */
export function describeWeekly(weekly: ReadonlyArray<WeeklySlot>) {
  const parts = inWeekOrder(weekly).map(
    (slot) => `los ${plural.get(slot.day)} a las ${slot.time}`,
  )
  const listed =
    parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`
      : (parts[0] ?? '')
  return `todos ${listed}`
}

/** "todos los martes a las 17:00, del 29 de septiembre al 29 de diciembre" */
export function describeRule(
  weekly: ReadonlyArray<WeeklySlot>,
  starts_on: LocalDate,
  ends_on: LocalDate,
) {
  const sameYear = starts_on.slice(0, 4) === ends_on.slice(0, 4)
  const on = (date: LocalDate) =>
    sameYear
      ? describeLocalDate(date)
      : `${describeLocalDate(date)} de ${date.slice(0, 4)}`
  return `${describeWeekly(weekly)}, del ${on(starts_on)} al ${on(ends_on)}`
}
