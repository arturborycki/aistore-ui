/**
 * Typed wrappers for the AIStor Tables operations exposed by the BFF.
 * Paths mirror the server's allow-list (backend/internal/catalog/routes.go).
 */
import { api, type Query } from './api'
import { encodeNamespace, type Namespace } from './namespace'

const c = (cluster: string) => `/api/c/${encodeURIComponent(cluster)}`
const w = (cluster: string, wh: string) => `${c(cluster)}/wh/${encodeURIComponent(wh)}`
const n = (cluster: string, wh: string, ns: Namespace) => `${w(cluster, wh)}/ns/${encodeNamespace(ns)}`

export type SortOrder = 'asc' | 'desc'

export interface EntryStats {
  namespaces?: number
  tables?: number
  records?: number
  size?: number
  [k: string]: number | undefined
}

export interface ListParams {
  search?: string
  page?: number
  pageSize?: number
  sort?: string
  sortOrder?: SortOrder
  uiToken?: string
}

export interface StatsPage<T> {
  items: T[]
  stats: Record<string, EntryStats>
  total: number | null
  uiToken?: string
}

function statsQuery(p: ListParams): Query {
  return {
    stats: true,
    page: p.page ?? 0,
    page_size: p.pageSize ?? 50,
    sort: p.sort && p.sort !== 'name' ? p.sort : undefined,
    sort_order: p.sortOrder,
    search: p.search?.trim() || undefined,
    ui_token: p.uiToken,
  }
}

function pageMeta(headers: Headers) {
  const total = headers.get('X-Minio-Ui-Total-Count')
  return {
    total: total != null && total !== '' ? Number(total) : null,
    uiToken: headers.get('X-Minio-Ui-List-Token') ?? undefined,
  }
}

// ---------------------------------------------------------------- cluster

export async function getGlobalStats(cluster: string) {
  return (await api.get<Record<string, unknown>>(`${c(cluster)}/stats`)).data
}

// ---------------------------------------------------------------- warehouses

export async function listWarehouses(cluster: string, p: ListParams): Promise<StatsPage<string>> {
  const r = await api.get<{ warehouses?: string[]; stats?: Record<string, EntryStats> }>(`${c(cluster)}/warehouses`, {
    query: statsQuery(p),
  })
  return { items: r.data?.warehouses ?? [], stats: r.data?.stats ?? {}, ...pageMeta(r.headers) }
}

/** Token-paginated plain listing (used by the explorer tree). */
export async function listAllWarehouses(cluster: string, search?: string): Promise<string[]> {
  const out: string[] = []
  let pageToken: string | undefined
  for (let i = 0; i < 50; i++) {
    const r = await api.get<{ warehouses?: string[]; 'next-page-token'?: string | null }>(`${c(cluster)}/warehouses`, {
      query: { pageSize: 1000, pageToken, search },
    })
    out.push(...(r.data?.warehouses ?? []))
    pageToken = r.data?.['next-page-token'] ?? undefined
    if (!pageToken) break
  }
  return out
}

export interface Warehouse {
  name: string
  bucket?: string
  uuid?: string
  'created-at'?: string
  properties?: Record<string, string>
}

export async function getWarehouse(cluster: string, wh: string) {
  return (await api.get<Warehouse>(w(cluster, wh))).data
}

export async function createWarehouse(cluster: string, name: string, upgradeExisting: boolean) {
  return (await api.post<{ name: string }>(`${c(cluster)}/warehouses`, { name, 'upgrade-existing': upgradeExisting })).data
}

export async function deleteWarehouse(cluster: string, wh: string, preserveBucket: boolean) {
  await api.del(w(cluster, wh), { query: { preserveBucket } })
}

// ---------------------------------------------------------------- namespaces

export interface NamespaceListParams extends ListParams {
  parent?: Namespace
}

export async function listNamespaces(cluster: string, wh: string, p: NamespaceListParams): Promise<StatsPage<Namespace>> {
  const r = await api.get<{ namespaces?: Namespace[]; stats?: Record<string, EntryStats> }>(`${w(cluster, wh)}/namespaces`, {
    query: { ...statsQuery(p), parent: p.parent?.length ? p.parent.join('\u001f') : undefined },
  })
  return { items: r.data?.namespaces ?? [], stats: r.data?.stats ?? {}, ...pageMeta(r.headers) }
}

export async function listAllNamespaces(cluster: string, wh: string, parent?: Namespace): Promise<Namespace[]> {
  const out: Namespace[] = []
  let pageToken: string | undefined
  for (let i = 0; i < 50; i++) {
    const r = await api.get<{ namespaces?: Namespace[]; 'next-page-token'?: string | null }>(`${w(cluster, wh)}/namespaces`, {
      query: { pageSize: 1000, pageToken, parent: parent?.length ? parent.join('\u001f') : undefined },
    })
    out.push(...(r.data?.namespaces ?? []))
    pageToken = r.data?.['next-page-token'] ?? undefined
    if (!pageToken) break
  }
  return out
}

/** Stats are keyed by entry name; accept the forms a server may use. */
export function namespaceStats(stats: Record<string, EntryStats>, ns: Namespace): EntryStats | undefined {
  return stats[ns.join('.')] ?? stats[ns[ns.length - 1]] ?? stats[ns.join('\u001f')]
}

export interface NamespaceInfo {
  namespace: Namespace
  properties?: Record<string, string>
}

export async function getNamespace(cluster: string, wh: string, ns: Namespace) {
  return (await api.get<NamespaceInfo>(n(cluster, wh, ns))).data
}

export async function createNamespace(cluster: string, wh: string, ns: Namespace, properties: Record<string, string>) {
  return (await api.post<NamespaceInfo>(`${w(cluster, wh)}/namespaces`, { namespace: ns, properties })).data
}

export async function deleteNamespace(cluster: string, wh: string, ns: Namespace) {
  await api.del(n(cluster, wh, ns))
}

export interface PropertiesUpdateResult {
  updated?: string[]
  removed?: string[]
  missing?: string[] | null
}

export async function updateNamespaceProperties(
  cluster: string,
  wh: string,
  ns: Namespace,
  updates: Record<string, string>,
  removals: string[],
) {
  const body: { updates?: Record<string, string>; removals?: string[] } = {}
  if (Object.keys(updates).length) body.updates = updates
  if (removals.length) body.removals = removals
  return (await api.post<PropertiesUpdateResult>(`${n(cluster, wh, ns)}/properties`, body)).data
}

// ---------------------------------------------------------------- ARNs

export const arn = {
  warehouse: (wh: string) => `arn:aws:s3tables:::bucket/${wh}`,
  tables: (wh: string) => `arn:aws:s3tables:::bucket/${wh}/table/*`,
  views: (wh: string) => `arn:aws:s3tables:::bucket/${wh}/view/*`,
}
