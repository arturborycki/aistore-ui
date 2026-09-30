/**
 * Typed wrappers for the AIStor Tables operations exposed by the BFF.
 * Paths mirror the server's allow-list (backend/internal/catalog/routes.go).
 */
import { api, type Query } from './api'
import { toTransaction, type TableChange } from './commits'
import { encodeNamespace, type Namespace } from './namespace'
import type { LoadTableResult, LoadViewResult, TableIdentifier } from './iceberg'

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

/**
 * AIStor's reserved system warehouse ("minio") is read-only and is returned
 * without a UUID, bucket or creation time.
 */
export function isSystemWarehouse(w?: Warehouse | null): boolean {
  return !!w && !w.uuid && !w.bucket && (!w['created-at'] || w['created-at'].startsWith('0001-'))
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

// ---------------------------------------------------------------- tables


const t = (cluster: string, wh: string, ns: Namespace, table: string) => `${n(cluster, wh, ns)}/t/${encodeURIComponent(table)}`
const v = (cluster: string, wh: string, ns: Namespace, view: string) => `${n(cluster, wh, ns)}/v/${encodeURIComponent(view)}`

export async function listTables(cluster: string, wh: string, ns: Namespace, p: ListParams): Promise<StatsPage<TableIdentifier>> {
  const r = await api.get<{ identifiers?: TableIdentifier[]; stats?: Record<string, EntryStats> }>(`${n(cluster, wh, ns)}/tables`, {
    query: statsQuery(p),
  })
  return { items: r.data?.identifiers ?? [], stats: r.data?.stats ?? {}, ...pageMeta(r.headers) }
}

async function listAllIdentifiers(path: string): Promise<TableIdentifier[]> {
  const out: TableIdentifier[] = []
  let pageToken: string | undefined
  for (let i = 0; i < 50; i++) {
    const r = await api.get<{ identifiers?: TableIdentifier[]; 'next-page-token'?: string | null }>(path, { query: { pageSize: 1000, pageToken } })
    out.push(...(r.data?.identifiers ?? []))
    pageToken = r.data?.['next-page-token'] ?? undefined
    if (!pageToken) break
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export const listAllTables = (cluster: string, wh: string, ns: Namespace) => listAllIdentifiers(`${n(cluster, wh, ns)}/tables`)
export const listAllViews = (cluster: string, wh: string, ns: Namespace) => listAllIdentifiers(`${n(cluster, wh, ns)}/views`)

export async function loadTable(cluster: string, wh: string, ns: Namespace, table: string) {
  return (await api.get<LoadTableResult>(t(cluster, wh, ns, table), { query: { snapshots: 'all' } })).data
}

export async function commitTableProperties(
  cluster: string,
  wh: string,
  ns: Namespace,
  table: string,
  tableUUID: string,
  updates: Record<string, string>,
  removals: string[],
) {
  const actions: Record<string, unknown>[] = []
  if (Object.keys(updates).length) actions.push({ action: 'set-properties', updates })
  if (removals.length) actions.push({ action: 'remove-properties', removals })
  return (
    await api.post<LoadTableResult>(t(cluster, wh, ns, table), {
      identifier: { namespace: ns, name: table },
      requirements: [{ type: 'assert-table-uuid', uuid: tableUUID }],
      updates: actions,
    })
  ).data
}

export async function dropTable(cluster: string, wh: string, ns: Namespace, table: string, purge: boolean) {
  await api.del(t(cluster, wh, ns, table), { query: { purge } })
}

export async function renameTable(cluster: string, wh: string, from: TableIdentifier, to: TableIdentifier) {
  await api.post(`${w(cluster, wh)}/tables/rename`, { source: from, destination: to })
}

export interface PreviewResult {
  schema: { name: string; type: string }[]
  rows: unknown[][]
  row_count: number
}

export async function previewTable(cluster: string, wh: string, ns: Namespace, table: string, limit: number) {
  return (await api.get<PreviewResult>(`${t(cluster, wh, ns, table)}/preview`, { query: { limit } })).data
}

export type MaintenanceType = 'icebergSnapshotManagement' | 'icebergCompaction' | 'icebergUnreferencedFileRemoval'
export interface MaintenanceJobStatus {
  status: 'Successful' | 'Failed' | 'Disabled' | 'Not_Yet_Run' | string
  lastRunTimestamp?: string
  failureMessage?: string
}

export async function getTableMaintenanceStatus(cluster: string, wh: string, ns: Namespace, table: string) {
  return (await api.get<{ tableARN?: string; status?: Partial<Record<MaintenanceType, MaintenanceJobStatus>> }>(`${t(cluster, wh, ns, table)}/maintenance-job-status`)).data
}

export async function getTableMaintenanceConfig(cluster: string, wh: string, ns: Namespace, table: string) {
  return (await api.get<Record<string, unknown>>(`${t(cluster, wh, ns, table)}/maintenance`)).data
}

export async function getTableEncryption(cluster: string, wh: string, ns: Namespace, table: string) {
  return (await api.get<Record<string, unknown>>(`${t(cluster, wh, ns, table)}/encryption`)).data
}

export async function getTableTags(cluster: string, wh: string, ns: Namespace, table: string) {
  return (await api.get<Record<string, unknown>>(`${t(cluster, wh, ns, table)}/tags`)).data
}

// ---------------------------------------------------------------- views

export async function loadView(cluster: string, wh: string, ns: Namespace, view: string) {
  return (await api.get<LoadViewResult>(v(cluster, wh, ns, view))).data
}

export async function dropView(cluster: string, wh: string, ns: Namespace, view: string) {
  await api.del(v(cluster, wh, ns, view))
}

export async function renameView(cluster: string, wh: string, from: TableIdentifier, to: TableIdentifier) {
  await api.post(`${w(cluster, wh)}/views/rename`, { source: from, destination: to })
}

export const resourceArn = {
  table: (wh: string, uuid: string) => `arn:aws:s3tables:::bucket/${wh}/table/${uuid}`,
  view: (wh: string, uuid: string) => `arn:aws:s3tables:::bucket/${wh}/view/${uuid}`,
}

// ---------------------------------------------------------------- writes (phases 2–3)


/** Commits one TableChange to its table. */
export async function commitTableChange(cluster: string, wh: string, change: TableChange) {
  const { identifier, requirements, updates } = change
  return (await api.post<LoadTableResult>(t(cluster, wh, identifier.namespace, identifier.name), { identifier, requirements, updates })).data
}

/** Applies several table changes atomically (all or nothing). */
export async function commitTransaction(cluster: string, wh: string, changes: TableChange[]) {
  await api.post(`${w(cluster, wh)}/transactions/commit`, toTransaction(changes))
}

export async function createTable(cluster: string, wh: string, ns: Namespace, body: Record<string, unknown>) {
  return (await api.post<LoadTableResult>(`${n(cluster, wh, ns)}/tables`, body)).data
}

export async function registerTable(cluster: string, wh: string, ns: Namespace, name: string, metadataLocation: string, overwrite = false) {
  const body: Record<string, unknown> = { name, 'metadata-location': metadataLocation }
  if (overwrite) body.overwrite = true
  return (await api.post<LoadTableResult>(`${n(cluster, wh, ns)}/register`, body)).data
}

export async function createView(cluster: string, wh: string, ns: Namespace, body: Record<string, unknown>) {
  return (await api.post<LoadViewResult>(`${n(cluster, wh, ns)}/views`, body)).data
}

export async function registerView(cluster: string, wh: string, ns: Namespace, name: string, metadataLocation: string) {
  return (await api.post<LoadViewResult>(`${n(cluster, wh, ns)}/register-view`, { name, 'metadata-location': metadataLocation })).data
}

export async function commitView(cluster: string, wh: string, ns: Namespace, view: string, requirements: unknown[], updates: unknown[]) {
  return (await api.post<LoadViewResult>(v(cluster, wh, ns, view), { identifier: { namespace: ns, name: view }, requirements, updates })).data
}

// Maintenance, encryption and tags use the AWS S3 Tables request shapes.
export interface MaintenanceValue {
  status: 'enabled' | 'disabled'
  settings?: Record<string, Record<string, number>>
}

export async function putTableMaintenance(cluster: string, wh: string, ns: Namespace, table: string, type: MaintenanceType, value: MaintenanceValue) {
  await api.put(`${t(cluster, wh, ns, table)}/maintenance/${type}`, { value })
}
export async function deleteTableMaintenance(cluster: string, wh: string, ns: Namespace, table: string, type: MaintenanceType) {
  await api.del(`${t(cluster, wh, ns, table)}/maintenance/${type}`)
}
export async function getWarehouseMaintenance(cluster: string, wh: string) {
  return (await api.get<Record<string, unknown>>(`${w(cluster, wh)}/maintenance`)).data
}
export async function putWarehouseMaintenance(cluster: string, wh: string, type: MaintenanceType, value: MaintenanceValue) {
  await api.put(`${w(cluster, wh)}/maintenance/${type}`, { value })
}

export interface EncryptionConfig {
  sseAlgorithm: 'AES256' | 'aws:kms'
  kmsKeyArn?: string
}
export async function getWarehouseEncryption(cluster: string, wh: string) {
  return (await api.get<Record<string, unknown>>(`${w(cluster, wh)}/encryption`)).data
}
export async function putWarehouseEncryption(cluster: string, wh: string, cfg: EncryptionConfig) {
  await api.put(`${w(cluster, wh)}/encryption`, { encryptionConfiguration: cfg })
}
export async function deleteWarehouseEncryption(cluster: string, wh: string) {
  await api.del(`${w(cluster, wh)}/encryption`)
}
export async function putTableEncryption(cluster: string, wh: string, ns: Namespace, table: string, cfg: EncryptionConfig) {
  await api.put(`${t(cluster, wh, ns, table)}/encryption`, { encryptionConfiguration: cfg })
}

export async function getWarehouseTags(cluster: string, wh: string) {
  return (await api.get<Record<string, unknown>>(`${w(cluster, wh)}/tags`)).data
}
export async function tagWarehouse(cluster: string, wh: string, tags: Record<string, string>) {
  await api.post(`${w(cluster, wh)}/tags`, { tags })
}
export async function untagWarehouse(cluster: string, wh: string, keys: string[]) {
  await api.del(`${w(cluster, wh)}/tags`, { query: { tagKeys: keys } })
}
export async function tagTable(cluster: string, wh: string, ns: Namespace, table: string, tags: Record<string, string>) {
  await api.post(`${t(cluster, wh, ns, table)}/tags`, { tags })
}
export async function untagTable(cluster: string, wh: string, ns: Namespace, table: string, keys: string[]) {
  await api.del(`${t(cluster, wh, ns, table)}/tags`, { query: { tagKeys: keys } })
}

export interface SearchHit {
  kind: 'warehouse' | 'namespace' | 'table' | 'view'
  warehouse: string
  /** parent namespace (for a namespace hit: its parent) */
  namespace?: string[]
  name: string
}

export interface SearchResult {
  results: SearchHit[]
  truncated: boolean
  requests: number
  skipped: number
}

/** Catalog-wide name search, run by the server with the caller's own permissions. */
export async function searchCatalog(cluster: string, q: string, signal?: AbortSignal) {
  return (await api.get<SearchResult>(`/api/c/${encodeURIComponent(cluster)}/search`, { query: { q, limit: 50 }, signal })).data
}

// ---------------------------------------------------------------- files & statistics

export interface InspectColumn {
  id: number
  path: string
  type: string
  valueCount?: number
  nullCount?: number
  nanCount?: number
  lower?: string
  upper?: string
  size?: number
  filesWithStats: number
  boundsTruncated?: boolean
}

export interface InspectFile {
  path: string
  content: 'data' | 'position-deletes' | 'equality-deletes'
  format: string
  specId: number
  partition?: { name: string; value: string }[]
  records: number
  size: number
  status: 'added' | 'existing'
  sequenceNumber?: number
}

export interface InspectManifest {
  path: string
  content: 'data' | 'deletes'
  specId: number
  length: number
  addedSnapshotId?: string
  addedFiles: number
  existingFiles: number
  deletedFiles: number
  addedRows: number
  existingRows: number
  deletedRows: number
  sequenceNumber: number
}

export interface InspectPartition {
  specId: number
  values: { name: string; value: string }[]
  records: number
  files: number
  size: number
  deleteFiles: number
}

export interface InspectResult {
  snapshotId: string
  manifestList: string
  summary: {
    manifests: number
    dataManifests: number
    deleteManifests: number
    dataFiles: number
    positionDeleteFiles: number
    equalityDeleteFiles: number
    records: number
    deleteFileRecords: number
    dataSize: number
    deleteSize: number
    entriesScanned: number
    manifestsScanned: number
    filesWithoutStats: number
  }
  manifests: InspectManifest[]
  files: InspectFile[]
  partitions: InspectPartition[]
  columns: InspectColumn[]
  truncated: boolean
  filesTruncated: boolean
}

/**
 * Manifests, files, partitions and per-column statistics of a snapshot
 * (default: current), read by the server from the table's manifest files
 * with the caller's own credentials.
 */
export async function inspectTable(cluster: string, wh: string, ns: Namespace, table: string, opts: { snapshot?: string; files?: number } = {}) {
  return (await api.get<InspectResult>(`${t(cluster, wh, ns, table)}/inspect`, { query: { snapshot: opts.snapshot, files: opts.files } })).data
}

export interface CatalogConfig {
  defaults?: Record<string, string>
  overrides?: Record<string, string>
  endpoints?: string[]
}

/** The Iceberg REST /config for a warehouse: client defaults, overrides and served endpoints. */
export async function getWarehouseConfig(cluster: string, wh: string) {
  return (await api.get<CatalogConfig>(`${w(cluster, wh)}/config`)).data
}
