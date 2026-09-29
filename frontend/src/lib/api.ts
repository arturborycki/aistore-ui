/**
 * HTTP client for the backend-for-frontend.
 *
 * - The session lives in an HttpOnly cookie; JavaScript never sees credentials.
 * - Every state-changing request carries the per-session CSRF token.
 * - Errors are normalised to ApiError (Iceberg ErrorModel shape) and carry the
 *   s3tables action / resource ARN the server reported, so "no access" states
 *   can tell the user exactly what permission is missing.
 * - A StepUpRequired response triggers the registered re-authentication flow
 *   and, on success, the request is retried once.
 */

export class ApiError extends Error {
  readonly status: number
  readonly type: string
  readonly action?: string
  readonly resource?: string
  readonly operation?: string
  readonly requestId?: string

  constructor(init: { status: number; type: string; message: string; headers?: Headers }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.type = init.type
    this.action = init.headers?.get('X-Aistor-Action') ?? undefined
    this.resource = init.headers?.get('X-Aistor-Resource') ?? undefined
    this.operation = init.headers?.get('X-Aistor-Operation') ?? undefined
    this.requestId = init.headers?.get('X-Request-Id') ?? undefined
  }

  get isAccessDenied() {
    return this.status === 403 && this.type !== 'StepUpRequired' && this.type !== 'CSRFRejected'
  }
  get isNotFound() {
    return this.status === 404
  }
  get isConflict() {
    return this.status === 409
  }
  get isSessionExpired() {
    return this.status === 401
  }
}

let csrfToken = ''
export function setCsrfToken(token: string) {
  csrfToken = token
}

type StepUpHandler = () => Promise<boolean>
let stepUpHandler: StepUpHandler | null = null
export function registerStepUpHandler(h: StepUpHandler | null) {
  stepUpHandler = h
}

type Listener = () => void
const expiredListeners = new Set<Listener>()
export function onSessionExpired(l: Listener) {
  expiredListeners.add(l)
  return () => {
    expiredListeners.delete(l)
  }
}

export type Query = Record<string, string | number | boolean | undefined | null | string[]>

export function buildQuery(q?: Query): string {
  if (!q) return ''
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x))
    else p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

export interface ApiResponse<T> {
  data: T
  headers: Headers
  status: number
}

export interface RequestOptions {
  query?: Query
  body?: unknown
  signal?: AbortSignal
  /** internal: set on the retry after step-up */
  _retried?: boolean
}

const SAFE = new Set(['GET', 'HEAD'])

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (!SAFE.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken

  let resp: Response
  try {
    resp = await fetch(path + buildQuery(opts.query), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: opts.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError({ status: 0, type: 'NetworkError', message: 'The server could not be reached. Check your connection.' })
  }

  if (resp.ok) {
    const text = resp.status === 204 ? '' : await resp.text()
    return { data: (text ? JSON.parse(text) : undefined) as T, headers: resp.headers, status: resp.status }
  }

  let type = 'HttpError'
  let message = resp.statusText || `Request failed (${resp.status})`
  try {
    const body = await resp.json()
    if (body?.error) {
      type = body.error.type || type
      message = body.error.message || message
    }
  } catch {
    /* non-JSON error body */
  }
  const err = new ApiError({ status: resp.status, type, message, headers: resp.headers })

  if (err.type === 'StepUpRequired' && stepUpHandler && !opts._retried) {
    const ok = await stepUpHandler()
    if (ok) return request<T>(method, path, { ...opts, _retried: true })
  }
  if (resp.status === 401 && !path.startsWith('/auth/')) {
    expiredListeners.forEach((l) => l())
  }
  throw err
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
}
