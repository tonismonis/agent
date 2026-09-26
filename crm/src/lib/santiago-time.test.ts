import { describe, expect, test } from 'vitest'

import {
  NonexistentClockTime,
  describeSantiagoSpan,
  describeSantiagoTime,
  rangeEnd,
  rangeStart,
  timeInput,
  rangeInput,
  toInstant,
  toRange,
} from './santiago-time'

const convert = { toInstant, rangeStart, rangeEnd }

describe('string from the model to instant', () => {
  test.each([
    ['2026-10-01T17:00', 'toInstant', '2026-10-01T20:00:00.000Z'],
    ['2026-08-03T10:00', 'toInstant', '2026-08-03T14:00:00.000Z'],
    ['2026-10-01T17:00:00-03:00', 'toInstant', '2026-10-01T20:00:00.000Z'],
    ['2026-10-01T20:00:00.000Z', 'toInstant', '2026-10-01T20:00:00.000Z'],
    ['2026-10-01T17:00:30.5', 'toInstant', '2026-10-01T20:00:30.500Z'],
    ['2026-09-06T01:30', 'toInstant', '2026-09-06T04:30:00.000Z'],
    ['2027-04-03T23:30', 'toInstant', '2027-04-04T02:30:00.000Z'],
    ['2026-09-29', 'rangeStart', '2026-09-29T03:00:00.000Z'],
    ['2026-09-29', 'rangeEnd', '2026-09-30T03:00:00.000Z'],
    ['2026-09-06', 'rangeStart', '2026-09-06T04:00:00.000Z'],
    ['2026-09-05', 'rangeEnd', '2026-09-06T04:00:00.000Z'],
    ['2027-04-03', 'rangeEnd', '2027-04-04T04:00:00.000Z'],
    ['2026-09-29T12:00', 'rangeStart', '2026-09-29T15:00:00.000Z'],
    ['2026-09-29T19:00', 'rangeEnd', '2026-09-29T22:00:00.000Z'],
  ] as const)('%s %s', (input, fn, expected) => {
    expect(convert[fn](input).toISOString()).toBe(expected)
  })

  test('a clock time in the skipped spring hour is rejected', () => {
    expect(() => toInstant('2026-09-06T00:30')).toThrow(NonexistentClockTime)
  })

  test('an impossible calendar date is rejected', () => {
    expect(() => toInstant('2026-02-30T10:00')).toThrow(/Not a real date/)
    expect(() => rangeStart('2026-09-31')).toThrow(/Not a real date/)
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
