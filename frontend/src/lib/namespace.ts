/**
 * Namespaces are arrays of levels. In URLs (both SPA routes and the BFF API)
 * they travel as percent-encoded levels joined by %1F, mirroring the Iceberg
 * REST convention, so no level can be confused with a path separator.
 */
export type Namespace = string[]

export const UNIT_SEPARATOR = '\u001f'

export function encodeNamespace(ns: Namespace): string {
  return ns.map(encodeURIComponent).join('%1F')
}

/** Decodes a route parameter (React Router has already percent-decoded it). */
export function decodeNamespaceParam(param: string | undefined): Namespace {
  if (!param) return []
  return param.split(UNIT_SEPARATOR).filter((l) => l.length > 0)
}

export function namespaceLabel(ns: Namespace): string {
  return ns.join('.')
}

export function parentOf(ns: Namespace): Namespace {
  return ns.slice(0, -1)
}

export function sameNamespace(a: Namespace, b: Namespace) {
  return a.length === b.length && a.every((l, i) => l === b[i])
}

/** Validates a single level before sending it to the server (mirrors backend rules). */
export function validateLevel(level: string): string | null {
  if (!level) return 'Name is required'
  if (level.length > 255) return 'Name is too long (max 255)'
  if (level === '.' || level === '..') return 'Name cannot be "." or ".."'
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(level)) return 'Name cannot contain slashes or control characters'
  return null
}

export const WAREHOUSE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
