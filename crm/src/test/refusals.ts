import { expect } from 'vitest'

import { readRefusal } from '#/lib/refusal'

/** The refusal a call rejected with, read the way the model reads it: from the message. */
export async function expectRefusal<T>(call: Promise<T>) {
  const error = await call.then(
    () => null,
    (reason: Error) => reason,
  )
  expect(error, 'the call was refused').toBeInstanceOf(Error)
  const refusal = readRefusal(error?.message ?? '')
  expect(refusal, `a refusal, not: ${error?.message}`).not.toBeNull()
  return refusal!
}
