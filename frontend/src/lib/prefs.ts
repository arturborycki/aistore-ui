// UI preferences only (theme, sidebar width, expanded tree nodes).
// Never store tokens or catalog data here.
/* eslint-disable no-restricted-globals */
export function getPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`aistor-ui:${key}`)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function setPref<T>(key: string, value: T) {
  try {
    localStorage.setItem(`aistor-ui:${key}`, JSON.stringify(value))
  } catch {
    /* storage unavailable (private mode): preferences are best-effort */
  }
}
