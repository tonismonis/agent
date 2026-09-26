import { describe, expect, test } from 'vitest'

import { readRefusal } from './refusal'
import { clock, localDate, santiagoClockOf, type Weekday } from './santiago-time'
import { describeRule, planSeries, type WeeklySlot } from './series'

const on = (value: string) => localDate.parse(value)
const slot = (day: Weekday, time: string): WeeklySlot => ({
  day,
  time: clock.parse(time),
})

describe('planSeries', () => {
  test('tuesdays at 17:00 until a date', () => {
    const plan = planSeries(
      [slot('tuesday', '17:00')],
      60,
      on('2026-09-29'),
      { until: on('2026-12-31') },
      [],
    )

    expect(plan.occurrences).toHaveLength(14)
    expect(plan.occurrences.map((each) => santiagoClockOf(each.span!.starts_at))).toEqual(
      Array(14).fill('17:00'),
    )
    expect(plan.ends_on).toBe('2026-12-31')
  })

  test('the clock time holds across the April change; the instant moves', () => {
    const { occurrences } = planSeries(
      [slot('tuesday', '17:00')],
      60,
      on('2027-03-23'),
      { until: on('2027-04-13') },
      [],
    )

    expect(occurrences.map((each) => each.span!.starts_at.toISOString())).toEqual([
      '2027-03-23T20:00:00.000Z',
      '2027-03-30T20:00:00.000Z',
      '2027-04-06T21:00:00.000Z',
      '2027-04-13T21:00:00.000Z',
    ])
  })

  test('a class in the skipped spring hour has no span', () => {
    const { occurrences } = planSeries(
      [slot('sunday', '00:30')],
      60,
      on('2026-08-30'),
      { count: 3 },
      [],
    )

    expect(occurrences.map((each) => [each.date, each.span === null])).toEqual([
      ['2026-08-30', false],
      ['2026-09-06', true],
      ['2026-09-13', false],
    ])
  })

  test('a count books that many classes; skipped dates push the end out', () => {
    const plan = planSeries(
      [slot('tuesday', '17:00')],
      60,
      on('2026-09-29'),
      { count: 3 },
      [on('2026-10-06')],
    )

    expect(plan.occurrences.map((each) => each.date)).toEqual([
      '2026-09-29',
      '2026-10-13',
      '2026-10-20',
    ])
    expect(plan.ends_on).toBe('2026-10-20')
  })

  test('two weekdays interleave in date order', () => {
    const plan = planSeries(
      [slot('thursday', '18:00'), slot('tuesday', '10:00')],
      60,
      on('2026-09-29'),
      { count: 4 },
      [],
    )

    expect(plan.occurrences.map((each) => [each.date, each.time])).toEqual([
      ['2026-09-29', '10:00'],
      ['2026-10-01', '18:00'],
      ['2026-10-06', '10:00'],
      ['2026-10-08', '18:00'],
    ])
  })

  test('more than 104 classes or a year asks for a nearer end', () => {
    const asks = (run: () => void) => {
      try {
        run()
      } catch (error) {
        return readRefusal(error instanceof Error ? error.message : '')?.kind
      }
      return null
    }
    const weekly = [slot('monday', '10:00'), slot('thursday', '10:00')]

    expect(asks(() => planSeries(weekly, 60, on('2026-09-28'), { count: 105 }, []))).toBe('ask')
    expect(
      asks(() => planSeries(weekly, 60, on('2026-09-28'), { until: on('2027-10-30') }, [])),
    ).toBe('ask')
    expect(asks(() => planSeries(weekly, 60, on('2026-09-28'), { count: 104 }, []))).toBeNull()
  })
})

test('describeRule says the rule the way the Owner does', () => {
  expect(describeRule([slot('tuesday', '17:00')], on('2026-09-29'), on('2026-12-29'))).toBe(
    'todos los martes a las 17:00, del 29 de septiembre al 29 de diciembre',
  )
  expect(
    describeRule(
      [slot('thursday', '18:00'), slot('tuesday', '17:00'), slot('saturday', '09:00')],
      on('2026-12-01'),
      on('2027-01-26'),
    ),
  ).toBe(
    'todos los martes a las 17:00, los jueves a las 18:00 y los sábados a las 09:00, del 1 de diciembre de 2026 al 26 de enero de 2027',
  )
})
