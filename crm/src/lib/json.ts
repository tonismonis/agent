/**
 * The JSON that crosses this app's boundaries: the args and results of a
 * streamed tool call, the arguments text of a code-mode call, the payload of a
 * custom event. Nothing here knows what a value means — it only says what the
 * value *is*, so the code that does know can branch on it.
 *
 * The guards are the one place `typeof` belongs: a decoded payload is narrowed
 * once, at the read, and every caller downstream works with a domain value.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | JsonObject

/** An object decoded from JSON: every value under it is JSON again. */
export type JsonObject = { [key: string]: JsonValue }

/**
 * The guards take `JsonValue | undefined` because a field read off a decoded
 * payload is routinely absent — `undefined` is "the payload didn't carry it",
 * and every guard answers `false` for it.
 */
export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === 'string'
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number'
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === 'boolean'
}

/** Decodes JSON text, or `undefined` when the text is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse returns exactly the value grammar JSON describes.
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}
