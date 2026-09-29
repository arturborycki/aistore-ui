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
  stepUpValidUntil?: string | null
  version: string
}

export interface Providers {
  oidc: { enabled: boolean; displayName: string }
  ldap: { enabled: boolean; displayName: string }
  builtin: { enabled: boolean }
  version: string
}

export const sessionApi = {
  me: async () => (await api.get<Me>('/auth/me')).data,
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

export async function listActivity(scope: 'me' | 'all', limit = 200) {
  return (await api.get<{ records: AuditRecord[] }>('/api/activity', { query: { scope: scope === 'all' ? 'all' : undefined, limit } })).data
    .records
}
