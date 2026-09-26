import { formatJson, isJsonNumber, isJsonObject, isJsonString, type JsonValue } from '#/lib/json'
import { readRefusal, refusalText } from '#/lib/refusal'
import { crmToolName } from '#/lib/write-receipts'

/** One code-mode event, read down to what the work margin renders from it. */
export type CodeModeEvent =
  | { kind: 'call'; name: string; args: JsonValue }
  | { kind: 'result'; name: string; result: JsonValue; durationMs?: number }
  | {
      kind: 'error'
      name: string
      message: string
      refused: boolean
      durationMs?: number
    }
  | { kind: 'failed'; message: string; refused: boolean; durationMs?: number }

/** A refusal reads as the sentence it carries; anything else as its own text. */
function readFailure(message: string) {
  const refusal = readRefusal(message)
  return refusal
    ? { message: refusalText(refusal), refused: true }
    : { message, refused: false }
}

/**
 * These payloads are the code-mode tool's own internals, not a contract it owes
 * anyone, so anything that doesn't read as one of the four events reads as
 * nothing happened.
 */
export function readCodeModeEvent(
  type: string,
  data: JsonValue,
): CodeModeEvent | null {
  if (!isJsonObject(data)) return null
  const durationMs = isJsonNumber(data.duration)
    ? data.duration
    : isJsonNumber(data.durationMs)
      ? data.durationMs
      : undefined

  if (type === 'code_mode:execution_finished') {
    if (data.success !== false) return null
    const error = data.error
    return {
      kind: 'failed',
      durationMs,
      ...readFailure(
        isJsonObject(error) && isJsonString(error.message)
          ? error.message
          : 'execution failed',
      ),
    }
  }

  if (!isJsonString(data.function)) return null
  const name = crmToolName(data.function)
  if (type === 'code_mode:external_call')
    return { kind: 'call', name, args: data.args }
  if (type === 'code_mode:external_result')
    return { kind: 'result', name, durationMs, result: data.result ?? null }
  if (type === 'code_mode:external_error')
    return {
      kind: 'error',
      name,
      durationMs,
      ...readFailure(formatJson(data.error)),
    }
  return null
}

