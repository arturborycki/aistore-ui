/**
 * JSON parsing that never silently corrupts 64-bit integers.
 *
 * Iceberg snapshot IDs are 64-bit and routinely exceed Number.MAX_SAFE_INTEGER;
 * a plain JSON.parse would round them, and a later commit (rollback, tag…)
 * would then reference a snapshot that does not exist. Every *snapshot-id
 * value is therefore kept as a string. Other unsafe integers (e.g. int64
 * values in data previews) are kept as their exact source text where the
 * browser supports JSON.parse source access.
 */
const SNAPSHOT_ID_KEY = /("(?:[a-z-]*snapshot-id)"\s*:\s*)(-?\d+)/g

export type Int64 = string

export function parseJSON<T = unknown>(text: string): T {
  const quoted = text.replace(SNAPSHOT_ID_KEY, '$1"$2"')
  return JSON.parse(quoted, function (_key, value, context?: { source?: string }) {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source) {
      return context.source
    }
    return value
  } as (this: unknown, key: string, value: unknown) => unknown) as T
}

/** Serialises a request body, emitting *snapshot-id strings as exact JSON integers. */
export function stringifyJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/("(?:[a-z-]*snapshot-id)"\s*:\s*)"(-?\d+)"/g, '$1$2')
    .replace(/("snapshot-ids"\s*:\s*)\[((?:"-?\d+",?)*)\]/g, (_m, key: string, list: string) => `${key}[${list.replace(/"/g, '')}]`)
}
