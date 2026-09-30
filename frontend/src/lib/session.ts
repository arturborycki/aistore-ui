import { api } from './api'

export interface User {
  sub: string
  username: string
  name?: string
  email?: string
  groups?: string[]
  method: 'oidc' | 'ldap' | 'builtin'
  admin: boolean
}

export interface ClusterInfo {
  id: string
  name: string
  available: boolean
  error?: string
}

export interface Me {
  user: User
  csrfToken: string
  clusters: ClusterInfo[]
  expiresAt: string
  idleTimeoutSeconds: number
  /** when the session ends without further activity (server view) */
  idleExpiresAt?: string
  stepUpValidUntil?: string | null
  /** earliest expiry of the AIStor credentials of a password session */
  credentialsExpireAt?: string | null
  sessionHandle?: string
  features?: { semantic?: { enabled: boolean; bucket?: string; serving?: boolean } }
  version: string
}

export interface Providers {
  oidc: { enabled: boolean; displayName: string }
  ldap: { enabled: boolean; displayName: string }
  builtin: { enabled: boolean }
  version: string
}

export const sessionApi = {
  me: async (background = false) => (await api.get<Me>('/auth/me', { background })).data,
  providers: async () => (await api.get<Providers>('/auth/providers')).data,
  loginLdap: async (username: string, password: string) =>
    (await api.post<Me>('/auth/ldap/login', { username, password })).data,
  loginBuiltin: async (accessKey: string, secretKey: string) =>
    (await api.post<Me>('/auth/builtin/login', { accessKey, secretKey })).data,
  stepUp: async (secret: string) => (await api.post<Me>('/auth/step-up', { secret })).data,
  logout: async () => (await api.post<{ redirect?: string }>('/auth/logout')).data,
}

export interface AuditRecord {
  time: string
  requestId: string
  kind: 'catalog' | 'auth'
  actor: { sub: string; username: string; method?: string }
  clientIp?: string
  operation: string
  action: string
  cluster: string
  resource: string
  arn: string
  params?: Record<string, string>
  status: number
  outcome: 'success' | 'denied' | 'failure'
  error?: string
  durationMs: number
}

export interface ActivityFilter {
  scope: 'me' | 'all'
  kind?: 'catalog' | 'auth'
  outcome?: AuditRecord['outcome']
  q?: string
  since?: string
  until?: string
}

export interface ActivityPage {
  records: AuditRecord[]
  total: number
  offset: number
  retained: number
}

export async function listActivity(f: ActivityFilter, offset = 0, limit = 100) {
  const { scope, ...rest } = f
  return (await api.get<ActivityPage>('/api/activity', { query: { ...rest, scope: scope === 'all' ? 'all' : undefined, offset, limit } })).data
}

/** Fetches every record matching the filter (for export), page by page. */
export async function listAllActivity(f: ActivityFilter) {
  const out: AuditRecord[] = []
  for (let offset = 0; ; ) {
    const page = await listActivity(f, offset, 500)
    out.push(...page.records)
    offset += page.records.length
    if (page.records.length === 0 || offset >= page.total) return out
  }
}

const CSV_COLUMNS: [string, (r: AuditRecord) => string | number | undefined][] = [
  ['time', (r) => r.time],
  ['user', (r) => r.actor.username],
  ['kind', (r) => r.kind],
  ['operation', (r) => r.operation],
  ['action', (r) => r.action],
  ['cluster', (r) => r.cluster],
  ['resource', (r) => r.resource],
  ['arn', (r) => r.arn],
  ['params', (r) => (r.params ? Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ') : '')],
  ['outcome', (r) => r.outcome],
  ['status', (r) => r.status],
  ['error', (r) => r.error],
  ['clientIp', (r) => r.clientIp],
  ['durationMs', (r) => r.durationMs],
  ['requestId', (r) => r.requestId],
]

/** RFC 4180 CSV; cells that a spreadsheet would evaluate as formulas are neutralised. */
export function activityCsv(records: AuditRecord[]): string {
  const cell = (v: string | number | undefined) => {
    let s = v == null ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [CSV_COLUMNS.map(([h]) => h).join(','), ...records.map((r) => CSV_COLUMNS.map(([, f]) => cell(f(r))).join(','))].join('\r\n') + '\r\n'
}

export interface SessionInfo {
  handle: string
  user: User
  createdAt: string
  lastSeen: string
  expiresAt: string
  clientIp?: string
  userAgent?: string
  current: boolean
}

export const sessionsApi = {
  mine: async () => (await api.get<{ sessions: SessionInfo[] }>('/api/sessions')).data.sessions,
  all: async () => (await api.get<{ sessions: SessionInfo[] }>('/api/admin/sessions')).data.sessions,
  revoke: async (handle: string) => {
    await api.del(`/api/sessions/${encodeURIComponent(handle)}`)
  },
  revokeOthers: async () => (await api.post<{ revoked: number }>('/api/sessions/revoke-others')).data.revoked,
  adminRevoke: async (sub: string, handle: string) => {
    await api.del('/api/admin/sessions', { query: { sub, handle } })
  },
}
