/**
 * Apache Iceberg metadata types (REST catalog LoadTable / LoadView) and
 * pure helpers used by the table and view pages.
 */
import type { Int64 } from './json'

export type IcebergType = string | StructType | ListType | MapType

export interface NestedField {
  id: number
  name: string
  type: IcebergType
  required: boolean
  doc?: string
  'initial-default'?: unknown
  'write-default'?: unknown
}

export interface StructType {
  type: 'struct'
  fields: NestedField[]
}
export interface ListType {
  type: 'list'
  'element-id': number
  element: IcebergType
  'element-required': boolean
}
export interface MapType {
  type: 'map'
  'key-id': number
  key: IcebergType
  'value-id': number
  value: IcebergType
  'value-required': boolean
}

export interface Schema extends StructType {
  'schema-id': number
  'identifier-field-ids'?: number[]
}

export interface PartitionField {
  name: string
  transform: string
  'source-id': number
  'field-id': number
}
export interface PartitionSpec {
  'spec-id': number
  fields: PartitionField[]
}

export interface SortField {
  transform: string
  'source-id': number
  direction: 'asc' | 'desc'
  'null-order': 'nulls-first' | 'nulls-last'
}
export interface SortOrder {
  'order-id': number
  fields: SortField[]
}

export interface Snapshot {
  'snapshot-id': Int64
  'parent-snapshot-id'?: Int64
  'sequence-number'?: number
  'timestamp-ms': number
  'manifest-list'?: string
  'schema-id'?: number
  summary: { operation: string; [k: string]: string }
}

export interface SnapshotRef {
  'snapshot-id': Int64
  type: 'branch' | 'tag'
  'min-snapshots-to-keep'?: number
  'max-snapshot-age-ms'?: number
  'max-ref-age-ms'?: number
}

export interface TableMetadata {
  'format-version': number
  'table-uuid': string
  location: string
  'last-sequence-number'?: number
  'last-updated-ms': number
  'last-column-id': number
  'current-schema-id': number
  schemas: Schema[]
  'default-spec-id': number
  'partition-specs': PartitionSpec[]
  'last-partition-id'?: number
  'default-sort-order-id'?: number
  'sort-orders'?: SortOrder[]
  properties?: Record<string, string>
  'current-snapshot-id'?: Int64 | null
  snapshots?: Snapshot[]
  refs?: Record<string, SnapshotRef>
  'snapshot-log'?: { 'snapshot-id': Int64; 'timestamp-ms': number }[]
  'metadata-log'?: { 'metadata-file': string; 'timestamp-ms': number }[]
  statistics?: unknown[]
}

export interface LoadTableResult {
  'metadata-location'?: string | null
  metadata: TableMetadata
  config?: Record<string, string>
}

export interface ViewRepresentation {
  type: 'sql'
  sql: string
  dialect: string
}
export interface ViewVersion {
  'version-id': number
  'timestamp-ms': number
  'schema-id': number
  summary?: Record<string, string>
  representations: ViewRepresentation[]
  'default-catalog'?: string
  'default-namespace'?: string[]
}
export interface ViewMetadata {
  'view-uuid': string
  'format-version': number
  location: string
  'current-version-id': number
  versions: ViewVersion[]
  'version-log'?: { 'version-id': number; 'timestamp-ms': number }[]
  schemas: Schema[]
  properties?: Record<string, string>
}
export interface LoadViewResult {
  'metadata-location'?: string
  metadata: ViewMetadata
}

export interface TableIdentifier {
  namespace: string[]
  name: string
}

// ---------------------------------------------------------------- types

export function isNested(t: IcebergType): t is StructType | ListType | MapType {
  return typeof t === 'object' && t !== null
}

/** Compact, human-readable type string, e.g. list<struct<3 fields>>. */
export function typeLabel(t: IcebergType): string {
  if (typeof t === 'string') return t
  switch (t.type) {
    case 'struct':
      return `struct<${t.fields.length} field${t.fields.length === 1 ? '' : 's'}>`
    case 'list':
      return `list<${typeLabel(t.element)}>`
    case 'map':
      return `map<${typeLabel(t.key)}, ${typeLabel(t.value)}>`
  }
}

/** Full type signature used for comparing fields across schema versions. */
export function typeSignature(t: IcebergType): string {
  if (typeof t === 'string') return t
  switch (t.type) {
    case 'struct':
      return `struct<${t.fields.map((f) => `${f.id}:${f.name}:${f.required ? '!' : '?'}${typeSignature(f.type)}`).join(',')}>`
    case 'list':
      return `list<${t['element-required'] ? '!' : '?'}${typeSignature(t.element)}>`
    case 'map':
      return `map<${typeSignature(t.key)},${t['value-required'] ? '!' : '?'}${typeSignature(t.value)}>`
  }
}

export type TypeFamily = 'numeric' | 'string' | 'temporal' | 'boolean' | 'binary' | 'nested' | 'other'

export function typeFamily(t: IcebergType): TypeFamily {
  if (typeof t !== 'string') return 'nested'
  if (/^(int|long|float|double|decimal)/.test(t)) return 'numeric'
  if (/^(string|uuid)/.test(t)) return 'string'
  if (/^(date|time|timestamp)/.test(t)) return 'temporal'
  if (t === 'boolean') return 'boolean'
  if (/^(binary|fixed)/.test(t)) return 'binary'
  return 'other'
}

/** A flattened view of a (possibly nested) field for tree-table rendering. */
export interface FlatField {
  id: number
  path: string[]
  name: string
  type: IcebergType
  required: boolean
  doc?: string
  depth: number
  hasChildren: boolean
  /** label for synthetic list/map members */
  role?: 'element' | 'key' | 'value'
}

function childrenOf(t: IcebergType, path: string[], depth: number): FlatField[] {
  if (typeof t === 'string') return []
  if (t.type === 'struct') return t.fields.flatMap((f) => flattenField(f, path, depth))
  if (t.type === 'list') {
    const el: FlatField = { id: t['element-id'], path: [...path, 'element'], name: 'element', type: t.element, required: t['element-required'], depth, hasChildren: isNested(t.element), role: 'element' }
    return [el, ...childrenOf(t.element, el.path, depth + 1)]
  }
  const key: FlatField = { id: t['key-id'], path: [...path, 'key'], name: 'key', type: t.key, required: true, depth, hasChildren: isNested(t.key), role: 'key' }
  const value: FlatField = { id: t['value-id'], path: [...path, 'value'], name: 'value', type: t.value, required: t['value-required'], depth, hasChildren: isNested(t.value), role: 'value' }
  return [key, ...childrenOf(t.key, key.path, depth + 1), value, ...childrenOf(t.value, value.path, depth + 1)]
}

function flattenField(f: NestedField, parent: string[], depth: number): FlatField[] {
  const path = [...parent, f.name]
  const self: FlatField = { id: f.id, path, name: f.name, type: f.type, required: f.required, doc: f.doc, depth, hasChildren: isNested(f.type) }
  return [self, ...childrenOf(f.type, path, depth + 1)]
}

export function flattenSchema(s: StructType): FlatField[] {
  return s.fields.flatMap((f) => flattenField(f, [], 0))
}

/** Maps field id → dotted column name for the given schema. */
export function fieldNames(s: StructType): Map<number, string> {
  return new Map(flattenSchema(s).map((f) => [f.id, f.path.join('.')]))
}

// ---------------------------------------------------------------- schema diff

export type FieldChange =
  | { kind: 'added'; field: FlatField }
  | { kind: 'removed'; field: FlatField }
  | { kind: 'renamed'; from: FlatField; to: FlatField }
  | { kind: 'type'; from: FlatField; to: FlatField }
  | { kind: 'nullability'; from: FlatField; to: FlatField }
  | { kind: 'doc'; from: FlatField; to: FlatField }

/** Compares two schema versions by field id (Iceberg's identity for columns). */
export function diffSchemas(prev: StructType, next: StructType): FieldChange[] {
  const a = new Map(flattenSchema(prev).map((f) => [f.id, f]))
  const b = new Map(flattenSchema(next).map((f) => [f.id, f]))
  const out: FieldChange[] = []
  for (const [id, f] of b) {
    const old = a.get(id)
    if (!old) {
      out.push({ kind: 'added', field: f })
      continue
    }
    if (old.name !== f.name) out.push({ kind: 'renamed', from: old, to: f })
    const ta = typeof old.type === 'string' ? old.type : old.type.type
    const tb = typeof f.type === 'string' ? f.type : f.type.type
    if (ta !== tb) out.push({ kind: 'type', from: old, to: f })
    if (old.required !== f.required) out.push({ kind: 'nullability', from: old, to: f })
    if ((old.doc ?? '') !== (f.doc ?? '')) out.push({ kind: 'doc', from: old, to: f })
  }
  for (const [id, f] of a) if (!b.has(id)) out.push({ kind: 'removed', field: f })
  return out
}

// ---------------------------------------------------------------- partitioning

export function transformLabel(transform: string, source: string): string {
  if (transform === 'identity') return source
  const m = /^(bucket|truncate)\[(\d+)\]$/.exec(transform)
  if (m) return `${m[1]}(${m[2]}, ${source})`
  return `${transform}(${source})`
}

// ---------------------------------------------------------------- snapshots

export function summaryNumber(s: Snapshot | undefined, key: string): number | undefined {
  const v = s?.summary?.[key]
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function currentSnapshot(md: TableMetadata): Snapshot | undefined {
  const id = md['current-snapshot-id']
  if (id == null || id === '-1') return undefined
  return md.snapshots?.find((s) => s['snapshot-id'] === id)
}

export function currentSchema(md: TableMetadata): Schema | undefined {
  return md.schemas.find((s) => s['schema-id'] === md['current-schema-id']) ?? md.schemas[md.schemas.length - 1]
}

/** Snapshots newest first, each annotated with the refs pointing at it. */
export function snapshotTimeline(md: TableMetadata) {
  const refsBySnap = new Map<string, { name: string; ref: SnapshotRef }[]>()
  for (const [name, ref] of Object.entries(md.refs ?? {})) {
    const k = String(ref['snapshot-id'])
    refsBySnap.set(k, [...(refsBySnap.get(k) ?? []), { name, ref }])
  }
  return [...(md.snapshots ?? [])]
    .sort((x, y) => y['timestamp-ms'] - x['timestamp-ms'])
    .map((s) => ({ snapshot: s, refs: refsBySnap.get(String(s['snapshot-id'])) ?? [] }))
}

export function shortId(id: Int64 | number | undefined | null): string {
  if (id == null) return '—'
  const s = String(id)
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s
}

// ---------------------------------------------------------------- views

export function currentViewVersion(md: ViewMetadata): ViewVersion | undefined {
  return md.versions.find((v) => v['version-id'] === md['current-version-id'])
}
