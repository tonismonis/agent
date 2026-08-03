const SANTIAGO_TIME_ZONE = 'America/Santiago'

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SANTIAGO_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function getDailyThreadId(now = new Date()) {
  const parts = Object.fromEntries(
    dateFormatter
      .formatToParts(now)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  )
  return `day-${parts.year}-${parts.month}-${parts.day}`
}

export function millisecondsUntilThreadRotation(now = new Date()) {
  const currentThread = getDailyThreadId(now)
  let low = now.getTime()
  let high = low + 27 * 60 * 60 * 1_000

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (getDailyThreadId(new Date(middle)) === currentThread) low = middle
    else high = middle
  }

  return Math.max(1, high - now.getTime())
}
