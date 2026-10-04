/**
 * Replaces one Owner's CRM data with five months of a clinical psychologist's
 * practice in Santiago, dated relative to today, so a demo can ask about
 * tomorrow's agenda, debts and past revenue. Other owners are untouched.
 *
 *   pnpm demo:seed [owner-email]   (defaults to DEMO_OWNER_EMAIL)
 */
import type pg from 'pg'

import { localAdminClient } from './local-admin.ts'

/** A Santiago calendar date, `2026-05-04`. */
type LocalDate = string
/** A Santiago wall-clock time, `09:00`. */
type Clock = string
/** A Santiago wall-clock instant, `2026-05-04T09:00`; SQL turns it into timestamptz. */
type Wall = string

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const
type Weekday = (typeof WEEKDAYS)[number]
type Mode = 'online' | 'in_person'
type Status = 'scheduled' | 'completed' | 'cancelled' | 'no_show'
type Slot = readonly [Weekday, Clock]

type Habit =
  | { kind: 'per_session' }
  /** Pays every session of a month together, on this business day of the next. */
  | { kind: 'monthly'; businessDay: number }
  /** Pays the day of the session, except the latest `owes` sessions. */
  | { kind: 'late'; owes: number }

/**
 * Weeks count from the first Monday after today: week 0 is the coming week,
 * -1 the one ending now.
 */
type Visits =
  | {
      kind: 'series'
      service: ServiceKind
      slots: ReadonlyArray<Slot>
      from: number
      /** The week of the last class; the series is ended right after it. */
      lastWeek?: number
    }
  | {
      kind: 'ad_hoc'
      service: ServiceKind
      everyWeeks: number
      /** In order of preference; the first free one is booked. */
      slots: ReadonlyArray<Slot>
      from: number
    }
  /** Came to one session and never booked again. */
  | { kind: 'once'; week: number; slot: Slot }

type Person = {
  name: string
  email?: string
  phone?: string
  notes?: string
  mode: Mode
  habit: Habit
  visits: Visits
}

const SEED = 20_260_504
const FIRST_WEEK = -22
/** Monday to Friday, 9 to 18: the last session starts at 17:00. */
const WORK_SLOTS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']
const PROFESSION = 'Psicología clínica'
const PRICE_BEFORE_RAISE = 38_000

const SERVICES = {
  individual: { name: 'Sesión individual', price: 40_000, minutes: 60 },
  couple: { name: 'Terapia de pareja', price: 55_000, minutes: 60 },
} as const
type ServiceKind = keyof typeof SERVICES

const perSession: Habit = { kind: 'per_session' }

const ROSTER: ReadonlyArray<Person> = [
  {
    name: 'Constanza Herrera',
    email: 'constanza.herrera@gmail.com',
    phone: '+56 9 8123 4567',
    notes: 'Prefiere la primera hora',
    mode: 'in_person',
    habit: perSession,
    visits: {
      kind: 'series',
      service: 'individual',
      slots: [['monday', '09:00'], ['thursday', '09:00']],
      from: -22,
    },
  },
  {
    name: 'Martina González',
    phone: '+56 9 7654 3210',
    notes: 'Paga por transferencia a inicios de mes',
    mode: 'in_person',
    habit: { kind: 'monthly', businessDay: 1 },
    visits: { kind: 'series', service: 'individual', slots: [['monday', '10:00']], from: -22 },
  },
  {
    name: 'Sebastián Rojas',
    email: 'sebarojas@outlook.com',
    mode: 'online',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['monday', '12:00']], from: -22 },
  },
  {
    name: 'Tomás Vargas',
    email: 'tomas.vargas@gmail.com',
    phone: '+56 9 6234 1180',
    mode: 'online',
    habit: perSession,
    visits: {
      kind: 'series',
      service: 'individual',
      slots: [['monday', '17:00']],
      from: -22,
      lastWeek: -7,
    },
  },
  {
    name: 'Rocío Fuentes',
    phone: '+56 9 9312 0045',
    notes: 'Derivada por Dra. Soto',
    mode: 'in_person',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['monday', '16:00']], from: -8 },
  },
  {
    name: 'Camila Rojas',
    email: 'camirojas.p@gmail.com',
    notes: 'Viene con su pareja, Diego',
    mode: 'in_person',
    habit: perSession,
    visits: { kind: 'series', service: 'couple', slots: [['monday', '15:00']], from: -20 },
  },
  {
    name: 'Isidora Araya',
    email: 'isidora.araya@gmail.com',
    notes: 'Prefiere online',
    mode: 'online',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['tuesday', '09:00']], from: -16 },
  },
  {
    name: 'Gabriel Pizarro',
    phone: '+56 9 5410 7723',
    mode: 'in_person',
    habit: { kind: 'monthly', businessDay: 2 },
    visits: { kind: 'series', service: 'individual', slots: [['tuesday', '11:00']], from: -22 },
  },
  {
    name: 'Valentina Muñoz',
    email: 'vale.munoz@gmail.com',
    phone: '+56 9 8876 5521',
    mode: 'online',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['tuesday', '17:00']], from: -22 },
  },
  {
    name: 'Ignacio Espinoza',
    email: 'iespinoza@uc.cl',
    notes: 'Paga por transferencia a fin de mes',
    mode: 'online',
    habit: { kind: 'monthly', businessDay: 1 },
    visits: { kind: 'series', service: 'individual', slots: [['tuesday', '15:00']], from: -12 },
  },
  {
    name: 'Catalina Pérez',
    phone: '+56 9 7120 3398',
    mode: 'in_person',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['wednesday', '09:00']], from: -22 },
  },
  {
    name: 'Emilia Sepúlveda',
    email: 'emilia.sepulveda@gmail.com',
    notes: 'Horario de almuerzo; trabaja cerca',
    mode: 'in_person',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['wednesday', '12:00']], from: -17 },
  },
  {
    name: 'Joaquín Soto',
    email: 'joaquin.soto@gmail.com',
    phone: '+56 9 6655 1902',
    mode: 'online',
    habit: { kind: 'late', owes: 3 },
    visits: { kind: 'series', service: 'individual', slots: [['wednesday', '17:00']], from: -22 },
  },
  {
    name: 'Agustina López',
    email: 'agus.lopez@gmail.com',
    phone: '+56 9 9045 2210',
    notes: 'Derivada por Dra. Soto',
    mode: 'in_person',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['wednesday', '16:00']], from: -2 },
  },
  {
    name: 'Francisca Silva',
    phone: '+56 9 8011 4476',
    mode: 'in_person',
    habit: { kind: 'monthly', businessDay: 2 },
    visits: { kind: 'series', service: 'individual', slots: [['thursday', '11:00']], from: -22 },
  },
  {
    name: 'Maximiliano Tapia',
    email: 'max.tapia@gmail.com',
    mode: 'online',
    habit: { kind: 'monthly', businessDay: 1 },
    visits: { kind: 'series', service: 'individual', slots: [['thursday', '15:00']], from: -6 },
  },
  {
    name: 'Benjamín Contreras',
    email: 'bcontreras@gmail.com',
    phone: '+56 9 7302 6614',
    notes: 'Prefiere online',
    mode: 'online',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['thursday', '10:00']], from: -18 },
  },
  {
    name: 'Antonia Morales',
    phone: '+56 9 9921 3307',
    mode: 'in_person',
    habit: perSession,
    visits: { kind: 'series', service: 'individual', slots: [['friday', '10:00']], from: -22 },
  },
  {
    name: 'Matías Fernández',
    email: 'matias.fernandez@gmail.com',
    mode: 'online',
    habit: { kind: 'late', owes: 4 },
    visits: { kind: 'series', service: 'individual', slots: [['friday', '15:00']], from: -14 },
  },
  {
    name: 'Javiera Torres',
    email: 'javi.torres@gmail.com',
    mode: 'online',
    habit: perSession,
    visits: {
      kind: 'ad_hoc',
      service: 'individual',
      everyWeeks: 2,
      slots: [['thursday', '17:00'], ['thursday', '16:00'], ['tuesday', '16:00']],
      from: -22,
    },
  },
  {
    name: 'Paula Gutiérrez',
    phone: '+56 9 6587 2093',
    mode: 'in_person',
    habit: { kind: 'late', owes: 2 },
    visits: {
      kind: 'ad_hoc',
      service: 'individual',
      everyWeeks: 2,
      slots: [['friday', '12:00'], ['friday', '11:00']],
      from: -21,
    },
  },
  {
    name: 'Rodrigo Navarro',
    email: 'rnavarro@gmail.com',
    notes: 'Terapia de pareja con su esposa, Carolina',
    mode: 'in_person',
    habit: { kind: 'monthly', businessDay: 1 },
    visits: {
      kind: 'ad_hoc',
      service: 'couple',
      everyWeeks: 2,
      slots: [['friday', '17:00'], ['friday', '16:00']],
      from: -22,
    },
  },
  {
    name: 'Diego Reyes',
    phone: '+56 9 5233 8841',
    mode: 'online',
    habit: perSession,
    visits: {
      kind: 'ad_hoc',
      service: 'individual',
      everyWeeks: 4,
      slots: [['wednesday', '15:00'], ['thursday', '12:00'], ['tuesday', '12:00']],
      from: -20,
    },
  },
  {
    name: 'Florencia Castillo',
    email: 'flo.castillo@gmail.com',
    notes: 'Solo puede los viernes',
    mode: 'in_person',
    habit: perSession,
    visits: {
      kind: 'ad_hoc',
      service: 'individual',
      everyWeeks: 3,
      slots: [['friday', '14:00'], ['friday', '13:00']],
      from: -21,
    },
  },
  {
    name: 'Vicente Álvarez',
    phone: '+56 9 8740 1136',
    mode: 'in_person',
    habit: perSession,
    visits: {
      kind: 'ad_hoc',
      service: 'individual',
      everyWeeks: 1,
      slots: [['friday', '09:00']],
      from: -1,
    },
  },
  {
    name: 'Fernanda Díaz',
    email: 'fer.diaz@gmail.com',
    mode: 'online',
    habit: perSession,
    visits: { kind: 'once', week: -16, slot: ['tuesday', '16:00'] },
  },
  {
    name: 'Sofía Ramírez',
    phone: '+56 9 7788 2045',
    mode: 'in_person',
    habit: perSession,
    visits: { kind: 'once', week: -5, slot: ['thursday', '12:00'] },
  },
]

/** Created twice by mistake one week in, and soft-deleted minutes later. */
const DUPLICATE = { of: 'Sebastián Rojas', name: 'Sebastian Rojas', week: -21 }

/** One class moved alone to another day; its series date stays put. */
const MOVED = {
  client: 'Valentina Muñoz',
  week: 1,
  from: 'tuesday',
  to: ['wednesday', '14:00'],
} as const

type ServiceRow = {
  kind: ServiceKind
  name: string
  firstPrice: number
  price: number
  minutes: number
  created: Wall
  updated: Wall
}
type ClientRow = {
  name: string
  email: string | null
  phone: string | null
  notes: string | null
  created: Wall
  deleted: Wall | null
}
type SeriesRow = {
  client: ClientRow
  service: ServiceRow
  mode: Mode
  minutes: number
  price: number
  startsOn: LocalDate
  endsOn: LocalDate
  bookedUntil: LocalDate
  days: Array<{ weekday: number; time: Clock }>
  created: Wall
  updated: Wall
}
type AppointmentRow = {
  client: ClientRow
  service: ServiceRow
  series: SeriesRow | null
  seriesDate: LocalDate | null
  starts: Wall
  minutes: number
  mode: Mode
  status: Status
  price: number
  created: Wall
  updated: Wall
}
type PaymentRow = {
  client: ClientRow
  appointment: AppointmentRow | null
  amount: number
  paidAt: Wall
  notes: string | null
}
type Row = ServiceRow | ClientRow | SeriesRow | AppointmentRow | PaymentRow

/** One agent write the Owner would have made, as the audit log records it. */
type AuditEntry =
  | { tool: 'createService'; ts: Wall; service: ServiceRow }
  | { tool: 'updateService'; ts: Wall; service: ServiceRow; price: number }
  | { tool: 'createClient'; ts: Wall; client: ClientRow }
  | { tool: 'softDeleteClient'; ts: Wall; client: ClientRow }
  | { tool: 'createAppointmentSeries'; ts: Wall; series: SeriesRow }
  | {
      tool: 'updateAppointmentSeries'
      ts: Wall
      series: SeriesRow
      change: { until: LocalDate } | { from: LocalDate; price: number }
    }
  | { tool: 'createAppointment'; ts: Wall; appointment: AppointmentRow }
  | {
      tool: 'updateAppointment'
      ts: Wall
      appointment: AppointmentRow
      change: { status: Status } | { starts_at: Wall }
    }
  | { tool: 'createPayment'; ts: Wall; payment: PaymentRow }

type DemoPlan = {
  services: Array<ServiceRow>
  clients: Array<ClientRow>
  series: Array<SeriesRow>
  appointments: Array<AppointmentRow>
  payments: Array<PaymentRow>
  audit: Array<AuditEntry>
}

function mulberry32(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const DAY_MS = 86_400_000

function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function getWeekday(date: LocalDate) {
  return new Date(`${date}T00:00Z`).getUTCDay()
}

function at(date: LocalDate, clock: Clock): Wall {
  return `${date}T${clock}`
}

function later(wall: Wall, minutes: number): Wall {
  return new Date(Date.parse(`${wall}Z`) + minutes * 60_000).toISOString().slice(0, 16)
}

function earliest(a: Wall, b: Wall) {
  return a < b ? a : b
}

function clockToMinutes(clock: Clock) {
  const [hours, minutes] = clock.split(':').map(Number)
  return hours * 60 + minutes
}

/** The first of the month `offset` months from `date`'s. */
function monthStart(date: LocalDate, offset: number): LocalDate {
  const [year, month] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10)
}

function nthBusinessDay(first: LocalDate, n: number) {
  let date = first
  let seen = 0
  for (;;) {
    const weekday = getWeekday(date)
    if (weekday !== 0 && weekday !== 6 && ++seen === n) return date
    date = addDays(date, 1)
  }
}

function lastWeekdayOnOrBefore(date: LocalDate, weekday: number) {
  return addDays(date, -((getWeekday(date) - weekday + 7) % 7))
}

/**
 * When the Owner took a week off, raised the individual rate, stopped work for
 * Fiestas Patrias and booked series until: fixed against the coming Monday so
 * the story reads the same whenever it is seeded.
 */
function calendarFor(anchor: LocalDate, start: LocalDate) {
  const priceRaise = monthStart(anchor, -3)
  const lastFriday = lastWeekdayOnOrBefore(addDays(monthStart(anchor, -2), -1), 5)
  // Each closed day, mapped to the day the Owner cancelled what fell on it.
  const closed = new Map<LocalDate, LocalDate>()
  for (let day = 0; day < 5; day++)
    closed.set(addDays(lastFriday, day - 4), addDays(lastFriday, -14))
  for (const year of new Set([start.slice(0, 4), anchor.slice(0, 4)]))
    for (const holiday of [`${year}-09-18`, `${year}-09-19`])
      closed.set(holiday, addDays(holiday, -7))
  return {
    priceRaise,
    closed,
    seriesUntil: lastWeekdayOnOrBefore(addDays(monthStart(anchor, 2), 17), 5),
  }
}

/** Which minutes of each day already hold a booking. */
function createAgenda() {
  const byDate = new Map<LocalDate, Array<[number, number]>>()
  const isFree = (date: LocalDate, clock: Clock, minutes: number) => {
    const from = clockToMinutes(clock)
    return (byDate.get(date) ?? []).every(([s, e]) => from + minutes <= s || from >= e)
  }
  const book = (date: LocalDate, clock: Clock, minutes: number) => {
    const taken = byDate.get(date) ?? []
    taken.push([clockToMinutes(clock), clockToMinutes(clock) + minutes])
    byDate.set(date, taken)
  }
  return { isFree, book }
}

function santiagoToday(): LocalDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date())
}

function planDemo(today: LocalDate): DemoPlan {
  const rng = mulberry32(SEED)
  const pick = (n: number) => Math.floor(rng() * n)
  let anchor = addDays(today, 1)
  while (getWeekday(anchor) !== 1) anchor = addDays(anchor, 1)
  const dateIn = (week: number, day: Weekday) =>
    addDays(anchor, week * 7 + ((WEEKDAYS.indexOf(day) + 6) % 7))
  const start = dateIn(FIRST_WEEK, 'monday')
  const setup = at(addDays(start, -2), '19:30')
  const yesterdayEvening = at(addDays(today, -1), '20:10')
  const horizon = addDays(today, 15)
  const calendar = calendarFor(anchor, start)
  const agenda = createAgenda()
  const plan: DemoPlan = {
    services: [],
    clients: [],
    series: [],
    appointments: [],
    payments: [],
    audit: [],
  }

  const serviceRow = (kind: ServiceKind, minute: number): ServiceRow => {
    const { name, price, minutes } = SERVICES[kind]
    const created = later(setup, minute)
    const firstPrice = kind === 'individual' ? PRICE_BEFORE_RAISE : price
    return { kind, name, firstPrice, price, minutes, created, updated: created }
  }
  const services = {
    individual: serviceRow('individual', 0),
    couple: serviceRow('couple', 1),
  }
  for (const row of Object.values(services)) {
    plan.services.push(row)
    plan.audit.push({ tool: 'createService', ts: row.created, service: row })
  }
  const individual = services.individual
  individual.updated = at(calendar.priceRaise, '09:05')
  plan.audit.push({
    tool: 'updateService',
    ts: individual.updated,
    service: individual,
    price: individual.price,
  })
  const priceAt = (row: ServiceRow, booked: Wall) =>
    booked < individual.updated ? row.firstPrice : row.price

  /** Past classes become completed, cancelled or no-shows, as the Owner closed them. */
  const settle = (appointment: AppointmentRow) => {
    const date = appointment.starts.slice(0, 10)
    if (date >= today) return
    const end = later(appointment.starts, appointment.minutes)
    const notice = calendar.closed.get(date)
    let status: Status = 'completed'
    let ts = earliest(later(end, 5 + pick(90)), at(date, '21:45'))
    if (notice !== undefined) {
      status = 'cancelled'
      ts = later(at(notice, '19:00'), pick(90))
    } else if (date >= addDays(today, -3) && rng() < 0.5) {
      return
    } else {
      const roll = rng()
      if (roll < 0.04) {
        status = 'cancelled'
        ts = later(at(addDays(date, -1), '18:00'), pick(180))
      } else if (roll < 0.07) {
        status = 'no_show'
        ts = later(end, 15 + pick(30))
      }
    }
    appointment.status = status
    appointment.updated = ts
    plan.audit.push({ tool: 'updateAppointment', ts, appointment, change: { status } })
  }

  const bookSingle = (
    person: Person,
    client: ClientRow,
    kind: ServiceKind,
    date: LocalDate,
    clock: Clock,
    booked: Wall,
  ) => {
    const row = services[kind]
    const { minutes } = row
    agenda.book(date, clock, minutes)
    const appointment: AppointmentRow = {
      client,
      service: row,
      series: null,
      seriesDate: null,
      starts: at(date, clock),
      minutes,
      mode: person.mode,
      status: 'scheduled',
      price: priceAt(row, booked),
      created: booked,
      updated: booked,
    }
    plan.appointments.push(appointment)
    plan.audit.push({ tool: 'createAppointment', ts: booked, appointment })
    settle(appointment)
    return appointment
  }

  /** Booked a few evenings ahead, or at the end of the client's last session. */
  const bookingTime = (date: LocalDate, previous: AppointmentRow | undefined) =>
    earliest(
      previous
        ? later(previous.starts, previous.minutes + 10)
        : later(at(addDays(date, -3), '19:00'), pick(90)),
      yesterdayEvening,
    )

  const byName = new Map<string, ClientRow>()
  for (const person of ROSTER) {
    const client: ClientRow = {
      name: person.name,
      email: person.email ?? null,
      phone: person.phone ?? null,
      notes: person.notes ?? null,
      created: setup,
      deleted: null,
    }
    plan.clients.push(client)
    byName.set(person.name, client)
    const { visits } = person

    switch (visits.kind) {
      case 'once': {
        const date = dateIn(visits.week, visits.slot[0])
        const clock = [visits.slot[1], ...WORK_SLOTS].find((each) =>
          agenda.isFree(date, each, services.individual.minutes),
        )
        if (clock === undefined) throw new Error(`no free hour for ${person.name} on ${date}`)
        bookSingle(person, client, 'individual', date, clock, bookingTime(date, undefined))
        break
      }
      case 'series': {
        const [firstDay, firstClock] = visits.slots[0]
        const row = services[visits.service]
        const { minutes } = row
        const startsOn = dateIn(visits.from, 'monday')
        const created =
          visits.from > FIRST_WEEK
            ? bookingTime(startsOn, undefined)
            : later(setup, 10 + plan.series.length * 3)
        const lastClass = visits.lastWeek === undefined ? undefined : dateIn(visits.lastWeek, firstDay)
        const end = lastClass
          ? { until: lastClass, at: later(at(lastClass, firstClock), minutes + 20) }
          : undefined
        const series: SeriesRow = {
          client,
          service: row,
          mode: person.mode,
          minutes,
          price: priceAt(row, created),
          startsOn,
          endsOn: calendar.seriesUntil,
          bookedUntil: calendar.seriesUntil,
          days: visits.slots.map(([day, time]) => ({ weekday: WEEKDAYS.indexOf(day), time })),
          created,
          updated: created,
        }
        plan.series.push(series)
        plan.audit.push({ tool: 'createAppointmentSeries', ts: created, series })
        // Regulars booked before the raise move to the new rate from that day.
        const raise =
          series.price === row.price || (lastClass !== undefined && lastClass < calendar.priceRaise)
            ? undefined
            : { from: calendar.priceRaise, at: later(individual.updated, 2 + plan.series.length) }
        for (let date = startsOn; date <= calendar.seriesUntil; date = addDays(date, 1)) {
          const slot = visits.slots.find(([day]) => WEEKDAYS.indexOf(day) === getWeekday(date))
          if (!slot) continue
          agenda.book(date, slot[1], minutes)
          const appointment: AppointmentRow = {
            client,
            service: row,
            series,
            seriesDate: date,
            starts: at(date, slot[1]),
            minutes,
            mode: person.mode,
            status: 'scheduled',
            price: series.price,
            created,
            updated: created,
          }
          if (raise && date >= raise.from) {
            appointment.price = row.price
            appointment.updated = raise.at
          }
          plan.appointments.push(appointment)
          if (end && date > end.until) {
            // Ending a series stamps it and the classes it cancels with one
            // instant; that is how a later extension finds them to reopen.
            appointment.status = 'cancelled'
            appointment.updated = end.at
          } else settle(appointment)
        }
        if (raise) {
          series.price = row.price
          series.updated = raise.at
          plan.audit.push({
            tool: 'updateAppointmentSeries',
            ts: raise.at,
            series,
            change: { from: raise.from, price: row.price },
          })
        }
        if (end) {
          series.endsOn = end.until
          series.updated = end.at
          plan.audit.push({
            tool: 'updateAppointmentSeries',
            ts: end.at,
            series,
            change: { until: end.until },
          })
        }
        break
      }
      case 'ad_hoc': {
        let previous: AppointmentRow | undefined
        const { minutes } = services[visits.service]
        for (let week = visits.from; ; week += visits.everyWeeks) {
          const preferred = pick(5) === 0 ? [...visits.slots].reverse() : visits.slots
          const options = preferred
            .map(([day, clock]) => ({ date: dateIn(week, day), clock }))
            .filter(({ date }) => !calendar.closed.has(date))
          if (options.length && options.every(({ date }) => date >= horizon)) break
          const free = options.find(
            ({ date, clock }) => date < horizon && agenda.isFree(date, clock, minutes),
          )
          if (!free) continue
          const appointment = bookSingle(
            person,
            client,
            visits.service,
            free.date,
            free.clock,
            bookingTime(free.date, previous),
          )
          if (free.date < today && appointment.status !== 'cancelled') previous = appointment
        }
        break
      }
    }
  }

  const moved = plan.appointments.find(
    (appointment) =>
      appointment.client.name === MOVED.client &&
      appointment.seriesDate === dateIn(MOVED.week, MOVED.from),
  )
  const movedTo = dateIn(MOVED.week, MOVED.to[0])
  if (!moved || !agenda.isFree(movedTo, MOVED.to[1], moved.minutes))
    throw new Error(`cannot move ${MOVED.client}'s class to ${movedTo} ${MOVED.to[1]}`)
  agenda.book(movedTo, MOVED.to[1], moved.minutes)
  moved.starts = at(movedTo, MOVED.to[1])
  moved.updated = yesterdayEvening
  plan.audit.push({
    tool: 'updateAppointment',
    ts: moved.updated,
    appointment: moved,
    change: { starts_at: moved.starts },
  })

  const habits = new Map(ROSTER.map((person) => [person.name, person.habit]))
  const monthlyPaidAt = new Map<string, Wall>()
  const pay = (appointment: AppointmentRow, paidAt: Wall, notes: string | null) => {
    const payment: PaymentRow = {
      client: appointment.client,
      appointment,
      amount: appointment.price,
      paidAt,
      notes,
    }
    plan.payments.push(payment)
    plan.audit.push({ tool: 'createPayment', ts: paidAt, payment })
  }
  for (const client of plan.clients) {
    const habit = habits.get(client.name) ?? perSession
    const completed = plan.appointments
      .filter((appointment) => appointment.client === client && appointment.status === 'completed')
      .sort((a, b) => (a.starts < b.starts ? -1 : 1))
    completed.forEach((appointment, index) => {
      const end = later(appointment.starts, appointment.minutes)
      switch (habit.kind) {
        case 'per_session':
          pay(appointment, later(end, 3 + pick(25)), null)
          break
        case 'late':
          if (index < completed.length - habit.owes) pay(appointment, later(end, 3 + pick(25)), null)
          break
        case 'monthly': {
          const month = `${client.name} ${appointment.starts.slice(0, 7)}`
          const nextMonth = monthStart(appointment.starts.slice(0, 10), 1)
          const payDay = nthBusinessDay(nextMonth, habit.businessDay)
          if (payDay >= today) break
          const paidAt = monthlyPaidAt.get(month) ?? later(at(payDay, '10:00'), pick(240))
          monthlyPaidAt.set(month, paidAt)
          pay(appointment, paidAt, null)
          break
        }
      }
    })
  }

  for (const client of plan.clients) {
    const first = [...plan.series, ...plan.appointments]
      .filter((row) => row.client === client)
      .reduce((min, row) => earliest(min, row.created), yesterdayEvening)
    client.created = later(first, -2)
    plan.audit.push({ tool: 'createClient', ts: client.created, client })
  }

  const original = byName.get(DUPLICATE.of)
  if (!original) throw new Error(`no client ${DUPLICATE.of}`)
  const deleted = at(dateIn(DUPLICATE.week, 'monday'), '11:52')
  const duplicate: ClientRow = {
    ...original,
    name: DUPLICATE.name,
    created: later(deleted, -4),
    deleted,
  }
  plan.clients.push(duplicate)
  plan.audit.push({ tool: 'createClient', ts: duplicate.created, client: duplicate })
  plan.audit.push({ tool: 'softDeleteClient', ts: deleted, client: duplicate })

  const byCreated = <T extends { created: Wall }>(rows: Array<T>) =>
    rows.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0))
  byCreated(plan.clients)
  byCreated(plan.series)
  plan.appointments.sort((a, b) =>
    a.created === b.created ? (a.starts < b.starts ? -1 : 1) : a.created < b.created ? -1 : 1,
  )
  plan.payments.sort((a, b) => (a.paidAt < b.paidAt ? -1 : a.paidAt > b.paidAt ? 1 : 0))
  plan.audit.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return plan
}

/** The tool input, entity and entity id a write of the Owner's left in the audit log. */
function auditRow(entry: AuditEntry, lookupId: (row: Row) => number) {
  switch (entry.tool) {
    case 'createService': {
      const { name, firstPrice, minutes } = entry.service
      return {
        input: { name, price: firstPrice, unit: 'flat', duration_minutes: minutes },
        entity: 'service',
        entity_id: lookupId(entry.service),
      }
    }
    case 'updateService':
      return {
        input: { id: lookupId(entry.service), price: entry.price },
        entity: 'service',
        entity_id: lookupId(entry.service),
      }
    case 'createClient': {
      const { name, email, phone, notes } = entry.client
      return {
        input: { name, email: email ?? undefined, phone: phone ?? undefined, notes: notes ?? undefined },
        entity: 'client',
        entity_id: lookupId(entry.client),
      }
    }
    case 'softDeleteClient':
      return { input: { id: lookupId(entry.client) }, entity: 'client', entity_id: lookupId(entry.client) }
    case 'createAppointmentSeries': {
      const { series } = entry
      return {
        input: {
          client_id: lookupId(series.client),
          service_id: lookupId(series.service),
          weekly: series.days.map(({ weekday, time }) => ({ day: WEEKDAYS[weekday], time })),
          from: series.startsOn,
          end: { until: series.bookedUntil },
          mode: series.mode,
        },
        entity: 'series',
        entity_id: lookupId(series),
      }
    }
    case 'updateAppointmentSeries':
      return {
        input: { id: lookupId(entry.series), ...entry.change },
        entity: 'series',
        entity_id: lookupId(entry.series),
      }
    case 'createAppointment': {
      const { appointment } = entry
      return {
        input: {
          client_id: lookupId(appointment.client),
          service_id: lookupId(appointment.service),
          starts_at: appointment.starts,
          mode: appointment.mode,
        },
        entity: 'appointment',
        entity_id: lookupId(appointment),
      }
    }
    case 'updateAppointment':
      return {
        input: { id: lookupId(entry.appointment), ...entry.change },
        entity: 'appointment',
        entity_id: lookupId(entry.appointment),
      }
    case 'createPayment': {
      const { payment } = entry
      return {
        input: {
          client_id: lookupId(payment.client),
          amount: payment.amount,
          appointment_id: payment.appointment ? lookupId(payment.appointment) : undefined,
          notes: payment.notes ?? undefined,
        },
        entity: 'payment',
        entity_id: lookupId(payment),
      }
    }
  }
}

const OWNER_TABLES = [
  'audit_log',
  'messages',
  'runs',
  'payments',
  'appointments',
  'appointment_series_days',
  'appointment_series',
  'clients',
  'services',
] as const

async function writePlan(admin: pg.Client, ownerId: string, plan: DemoPlan) {
  for (const table of OWNER_TABLES)
    await admin.query(`DELETE FROM ${admin.escapeIdentifier(table)} WHERE owner_id = $1`, [ownerId])
  await admin.query('UPDATE owners SET profession = $2 WHERE id = $1', [ownerId, PROFESSION])

  // Ids are reserved up front so every row, and the audit input naming it,
  // knows its id before anything is inserted.
  const ids = new Map<Row, number>()
  const reserve = async (table: string, rows: ReadonlyArray<Row>) => {
    const { rows: reserved } = await admin.query<{ id: number }>(
      `SELECT nextval(pg_get_serial_sequence($1, 'id'))::int AS id
       FROM generate_series(1, $2::int) ORDER BY 1`,
      [table, rows.length],
    )
    rows.forEach((row, i) => ids.set(row, reserved[i].id))
  }
  await reserve('services', plan.services)
  await reserve('clients', plan.clients)
  await reserve('appointment_series', plan.series)
  await reserve('appointments', plan.appointments)
  await reserve('payments', plan.payments)
  const lookupId = (row: Row) => {
    const id = ids.get(row)
    if (id === undefined) throw new Error('a planned row references one that was not planned')
    return id
  }

  const insert = async <T>(table: string, sql: string, rows: ReadonlyArray<T>) => {
    const result = await admin.query(sql, [ownerId, JSON.stringify(rows)])
    console.log(`${table}: inserted ${result.rowCount}`)
  }
  const local = (column: string) => `${column} AT TIME ZONE 'America/Santiago'`

  await insert(
    'services',
    `INSERT INTO services (id, owner_id, name, price, unit, duration_minutes, created_at, updated_at)
     SELECT r.id, $1, r.name, r.price, 'flat', r.minutes, ${local('r.created')}, ${local('r.updated')}
     FROM jsonb_to_recordset($2::jsonb)
       AS r(id int, name text, price int, minutes int, created timestamp, updated timestamp)`,
    plan.services.map((row) => ({ ...row, id: lookupId(row) })),
  )
  await insert(
    'clients',
    `INSERT INTO clients (id, owner_id, name, email, phone, notes, created_at, updated_at, deleted_at)
     SELECT r.id, $1, r.name, r.email, r.phone, r.notes,
       ${local('r.created')}, ${local('r.created')}, ${local('r.deleted')}
     FROM jsonb_to_recordset($2::jsonb)
       AS r(id int, name text, email text, phone text, notes text,
         created timestamp, deleted timestamp)`,
    plan.clients.map((row) => ({ ...row, id: lookupId(row) })),
  )
  await insert(
    'appointment_series',
    `INSERT INTO appointment_series (id, owner_id, client_id, service_id, mode, duration_minutes,
       price, starts_on, ends_on, created_at, updated_at)
     SELECT r.id, $1, r.client_id, r.service_id, r.mode::appointment_mode, r.minutes,
       r.price, r.starts_on, r.ends_on, ${local('r.created')}, ${local('r.updated')}
     FROM jsonb_to_recordset($2::jsonb)
       AS r(id int, client_id int, service_id int, mode text, minutes int, price int,
         starts_on date, ends_on date, created timestamp, updated timestamp)`,
    plan.series.map((row) => ({
      id: lookupId(row),
      client_id: lookupId(row.client),
      service_id: lookupId(row.service),
      mode: row.mode,
      minutes: row.minutes,
      price: row.price,
      starts_on: row.startsOn,
      ends_on: row.endsOn,
      created: row.created,
      updated: row.updated,
    })),
  )
  await insert(
    'appointment_series_days',
    `INSERT INTO appointment_series_days (series_id, owner_id, weekday, starts_time)
     SELECT r.series_id, $1, r.weekday, r.time
     FROM jsonb_to_recordset($2::jsonb) AS r(series_id int, weekday int, time time)`,
    plan.series.flatMap((row) => row.days.map((day) => ({ ...day, series_id: lookupId(row) }))),
  )
  await insert(
    'appointments',
    `INSERT INTO appointments (id, owner_id, client_id, service_id, starts_at, ends_at, mode,
       status, price, series_id, series_date, created_at, updated_at)
     SELECT r.id, $1, r.client_id, r.service_id, ${local('r.starts')},
       ${local('r.starts')} + make_interval(mins => r.minutes), r.mode::appointment_mode,
       r.status::appointment_status, r.price, r.series_id, r.series_date,
       ${local('r.created')}, ${local('r.updated')}
     FROM jsonb_to_recordset($2::jsonb)
       AS r(id int, client_id int, service_id int, starts timestamp, minutes int, mode text,
         status text, price int, series_id int, series_date date, created timestamp,
         updated timestamp)`,
    plan.appointments.map((row) => ({
      id: lookupId(row),
      client_id: lookupId(row.client),
      service_id: lookupId(row.service),
      starts: row.starts,
      minutes: row.minutes,
      mode: row.mode,
      status: row.status,
      price: row.price,
      series_id: row.series ? lookupId(row.series) : null,
      series_date: row.seriesDate,
      created: row.created,
      updated: row.updated,
    })),
  )
  await insert(
    'payments',
    `INSERT INTO payments (id, owner_id, client_id, appointment_id, amount, paid_at, notes,
       created_at, updated_at)
     SELECT r.id, $1, r.client_id, r.appointment_id, r.amount, ${local('r.paid_at')}, r.notes,
       ${local('r.paid_at')}, ${local('r.paid_at')}
     FROM jsonb_to_recordset($2::jsonb)
       AS r(id int, client_id int, appointment_id int, amount int, paid_at timestamp, notes text)`,
    plan.payments.map((row) => ({
      id: lookupId(row),
      client_id: lookupId(row.client),
      appointment_id: row.appointment ? lookupId(row.appointment) : null,
      amount: row.amount,
      paid_at: row.paidAt,
      notes: row.notes,
    })),
  )
  await insert(
    'audit_log',
    `INSERT INTO audit_log (owner_id, tool_name, input, entity, entity_id, before, ok, error, ts)
     SELECT $1, r.tool_name, r.input, r.entity, r.entity_id, NULL, true, NULL, ${local('r.ts')}
     FROM jsonb_to_recordset($2::jsonb)
       AS r(n int, tool_name text, input jsonb, entity text, entity_id int, ts timestamp)
     ORDER BY r.n`,
    plan.audit.map((entry, n) => ({ n, tool_name: entry.tool, ts: entry.ts, ...auditRow(entry, lookupId) })),
  )
}

const email = process.argv[2] ?? process.env.DEMO_OWNER_EMAIL
if (!email) {
  console.error('usage: pnpm demo:seed [owner-email], or set DEMO_OWNER_EMAIL')
  process.exit(1)
}

const admin = localAdminClient('seed')
await admin.connect()
try {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM owners WHERE email = $1', [email])
  const owner = rows[0]
  if (!owner) {
    console.error(`no owner with email ${email}; owners are invited, never created here`)
    process.exitCode = 1
  } else {
    const today = santiagoToday()
    await admin.query('BEGIN')
    try {
      await writePlan(admin, owner.id, planDemo(today))
      await admin.query('COMMIT')
    } catch (error) {
      await admin.query('ROLLBACK')
      throw error
    }
    console.log(`Seeded ${email} as of ${today} (America/Santiago).`)
    console.log('Reload any open chat tab; it still holds the old transcript in memory.')
  }
} finally {
  await admin.end()
}
