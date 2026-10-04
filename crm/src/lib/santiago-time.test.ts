import { describe, expect, test } from 'vitest'

import {
  NonexistentClockTime,
  addDays,
  describeLocalDay,
  localDate,
  localInstant,
  resolveTime,
  toSantiagoClock,
  toSantiagoDate,
  getWeekday,
  clock,
  describeSantiagoSpan,
  describeSantiagoTime,
  rangeEnd,
  toStartInstant,
  timeInput,
  rangeInput,
  toInstant,
  toRange,
} from './santiago-time'

const convert = { toInstant, toStartInstant, rangeEnd }

describe('string from the model to instant', () => {
  test.each([
    ['2026-10-01T17:00', 'toInstant', '2026-10-01T20:00:00.000Z'],
    ['2026-08-03T10:00', 'toInstant', '2026-08-03T14:00:00.000Z'],
    ['2026-10-01T17:00:00-03:00', 'toInstant', '2026-10-01T20:00:00.000Z'],
    ['2026-10-01T20:00:00.000Z', 'toInstant', '2026-10-01T20:00:00.000Z'],
    ['2026-10-01T17:00:30.5', 'toInstant', '2026-10-01T20:00:30.500Z'],
    ['2026-09-06T01:30', 'toInstant', '2026-09-06T04:30:00.000Z'],
    ['2027-04-03T23:30', 'toInstant', '2027-04-04T02:30:00.000Z'],
    ['2026-09-29', 'toStartInstant', '2026-09-29T03:00:00.000Z'],
    ['2026-09-29', 'rangeEnd', '2026-09-30T03:00:00.000Z'],
    ['2026-09-06', 'toStartInstant', '2026-09-06T04:00:00.000Z'],
    ['2026-09-05', 'rangeEnd', '2026-09-06T04:00:00.000Z'],
    ['2027-04-03', 'rangeEnd', '2027-04-04T04:00:00.000Z'],
    ['2026-09-29T12:00', 'toStartInstant', '2026-09-29T15:00:00.000Z'],
    ['2026-09-29T19:00', 'rangeEnd', '2026-09-29T22:00:00.000Z'],
  ] as const)('%s %s', (input, fn, expected) => {
    expect(convert[fn](input).toISOString()).toBe(expected)
  })

  test('a clock time in the skipped spring hour is rejected', () => {
    expect(() => toInstant('2026-09-06T00:30')).toThrow(NonexistentClockTime)
  })

  test('an impossible calendar date is rejected', () => {
    expect(() => toInstant('2026-02-30T10:00')).toThrow(/Not a real date/)
    expect(() => toStartInstant('2026-09-31')).toThrow(/Not a real date/)
  })

  test('toRange leaves missing bounds open', () => {
    expect(toRange(undefined, '2026-09-29')).toEqual({
      start: null,
      end: new Date('2026-09-30T03:00:00.000Z'),
    })
  })

  test('schemas take clock times and dates, not free text', () => {
    expect(timeInput.safeParse('2026-10-01T17:00').success).toBe(true)
    expect(timeInput.safeParse('2026-10-01').success).toBe(false)
    expect(timeInput.safeParse('jueves 17:00').success).toBe(false)
    expect(rangeInput.safeParse('2026-10-01').success).toBe(true)
    expect(rangeInput.safeParse('2026-10-01T17:00-03:00').success).toBe(true)
  })
})

describe('Santiago wording', () => {
  test('describes an instant and a span in Santiago clock time', () => {
    const start = new Date('2026-10-01T20:00:00.000Z')
    const end = new Date('2026-10-01T21:00:00.000Z')
    expect(describeSantiagoTime(start)).toBe('jueves 1 de octubre, 17:00')
    expect(describeSantiagoSpan(start, end)).toBe(
      'jueves 1 de octubre, 17:00–18:00',
    )
  })

  test('a span across midnight names both days', () => {
    expect(
      describeSantiagoSpan(
        new Date('2026-10-02T02:30:00.000Z'),
        new Date('2026-10-02T03:30:00.000Z'),
      ),
    ).toBe('jueves 1 de octubre, 23:30 – viernes 2 de octubre, 00:30')
  })
})

describe('Santiago calendar dates', () => {
  const day = (value: string) => localDate.parse(value)
  const at = (value: string) => clock.parse(value)

  test('a date and clock time name one instant, or none in the spring gap', () => {
    expect(localInstant(day('2026-09-06'), at('00:30'))).toBeNull()
    expect(localInstant(day('2026-09-06'), at('01:00'))?.toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    )
    expect(localInstant(day('2027-04-03'), at('23:30'))?.toISOString()).toBe(
      '2027-04-04T02:30:00.000Z',
    )
  })

  test('calendar steps ignore clock changes', () => {
    expect(addDays(day('2026-09-01'), 7)).toBe('2026-09-08')
    expect(addDays(day('2027-03-30'), 7)).toBe('2027-04-06')
    expect(addDays(day('2026-12-29'), 7)).toBe('2027-01-05')
    expect(getWeekday(day('2026-09-29'))).toBe('tuesday')
    expect(getWeekday(day('2026-09-06'))).toBe('sunday')
  })

  test('an instant reads back as its Santiago date and clock', () => {
    const instant = new Date('2026-10-01T02:30:00.000Z')
    expect(toSantiagoDate(instant)).toBe('2026-09-30')
    expect(toSantiagoClock(instant)).toBe('23:30')
  })

  test('the day is named from the date itself, gap or not', () => {
    expect(describeLocalDay(day('2026-09-06'))).toBe('domingo 6 de septiembre')
    expect(describeLocalDay(day('2026-11-17'))).toBe('martes 17 de noviembre')
  })

  test('resolveTime keeps the clock the model wrote', () => {
    expect(resolveTime('2026-09-06T00:30')).toEqual({
      date: '2026-09-06',
      time: '00:30',
      instant: null,
    })
    expect(resolveTime('2026-10-01T20:00:00Z')).toEqual({
      date: '2026-10-01',
      time: '17:00',
      instant: new Date('2026-10-01T20:00:00.000Z'),
    })
  })

  test('schemas refuse impossible dates before any tool runs', () => {
    expect(localDate.safeParse('2026-02-30').success).toBe(false)
    expect(timeInput.safeParse('2026-02-30T10:00').success).toBe(false)
    expect(clock.safeParse('24:00').success).toBe(false)
  })
})
