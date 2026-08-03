import { expect, test } from 'vitest'

import { getDailyThreadId } from './chat-thread'

test('rotates the daily thread at Santiago midnight', () => {
  expect(getDailyThreadId(new Date('2026-08-03T03:59:59.999Z'))).toBe(
    'day-2026-08-02',
  )
  expect(getDailyThreadId(new Date('2026-08-03T04:00:00.000Z'))).toBe(
    'day-2026-08-03',
  )
})
