/**
 * Builders that turn UI intents into Iceberg REST commits
 * (`requirements` + `updates`). Requirements capture the metadata the user was
 * looking at, so a concurrent change by someone else makes the commit fail
 * with 409 instead of silently overwriting it.
 */
import type { Int64 } from './json'
import type { NestedField, PartitionField, SortField, TableIdentifier, TableMetadata } from './iceberg'
import { currentSchema, fieldNames, transformLabel } from './iceberg'

export type Requirement = { type: string; [k: string]: unknown }
export type Update = { action: string; [k: string]: unknown }

/** What a change touches; at most one staged change per table and kind (properties merge). */
export type ChangeKind = 'properties' | 'schema' | 'spec' | 'sort' | 'format' | `ref:${string}`

export interface TableChange {
  identifier: TableIdentifier
  kind: ChangeKind
  summary: string
  requirements: Requirement[]
  updates: Update[]
}

const uuidReq = (md: TableMetadata): Requirement => ({ type: 'assert-table-uuid', uuid: md['table-uuid'] })

const maxOf = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), -1)

// ---------------------------------------------------------------- properties

export function propertiesChange(md: TableMetadata, id: TableIdentifier, updates: Record<string, string>, removals: string[]): TableChange {
  const u: Update[] = []
  if (Object.keys(updates).length) u.push({ action: 'set-properties', updates })
  if (removals.length) u.push({ action: 'remove-properties', removals })
  const parts = [Object.keys(updates).length && `set ${Object.keys(updates).join(', ')}`, removals.length && `remove ${removals.join(', ')}`].filter(Boolean)
  return { identifier: id, kind: 'properties', summary: `Properties: ${parts.join('; ')}`, requirements: [uuidReq(md)], updates: u }
}

// ---------------------------------------------------------------- schema

export function schemaChange(md: TableMetadata, id: TableIdentifier, fields: NestedField[], lastColumnId: number, summary: string): TableChange {
  const cur = currentSchema(md)
  const nextId = maxOf(md.schemas.map((s) => s['schema-id'])) + 1
  const schema: Record<string, unknown> = { type: 'struct', 'schema-id': nextId, fields }
  if (cur?.['identifier-field-ids']?.length) schema['identifier-field-ids'] = cur['identifier-field-ids']
  return {
    identifier: id,
    kind: 'schema',
    summary,
    requirements: [
      uuidReq(md),
      { type: 'assert-current-schema-id', 'current-schema-id': md['current-schema-id'] },
      { type: 'assert-last-assigned-field-id', 'last-assigned-field-id': md['last-column-id'] },
    ],
    updates: [
      { action: 'add-schema', schema, 'last-column-id': Math.max(lastColumnId, md['last-column-id']) },
      { action: 'set-current-schema', 'schema-id': -1 },
    ],
  }
}

// ---------------------------------------------------------------- partitioning

export interface SpecFieldDraft {
  sourceId: number
  transform: string
  name: string
  /** field id kept from an existing spec field */
  fieldId?: number
}

/**
 * Assigns partition field ids: a (source, transform) pair already used by any
 * spec keeps its id (as Iceberg requires); new pairs get last-partition-id+1…
 */
export function assignPartitionFieldIds(md: TableMetadata, drafts: SpecFieldDraft[]): PartitionField[] {
  const known = new Map<string, number>()
  for (const s of md['partition-specs']) for (const f of s.fields) known.set(`${f['source-id']}|${f.transform}`, f['field-id'])
  let next = Math.max(md['last-partition-id'] ?? 999, ...md['partition-specs'].flatMap((s) => s.fields.map((f) => f['field-id'])), 999) + 1
  return drafts.map((d) => ({
    name: d.name,
    transform: d.transform,
    'source-id': d.sourceId,
    'field-id': d.fieldId ?? known.get(`${d.sourceId}|${d.transform}`) ?? next++,
  }))
}

export function specChange(md: TableMetadata, id: TableIdentifier, fields: PartitionField[]): TableChange {
  const names = fieldNames(currentSchema(md)!)
  const nextId = maxOf(md['partition-specs'].map((s) => s['spec-id'])) + 1
  const label = fields.length ? fields.map((f) => transformLabel(f.transform, names.get(f['source-id']) ?? '?')).join(', ') : 'unpartitioned'
  const req: Requirement[] = [uuidReq(md), { type: 'assert-default-spec-id', 'default-spec-id': md['default-spec-id'] }]
  if (md['last-partition-id'] != null) req.push({ type: 'assert-last-assigned-partition-id', 'last-assigned-partition-id': md['last-partition-id'] })
  return {
    identifier: id,
    kind: 'spec',
    summary: `Partitioning → ${label}`,
    requirements: req,
    updates: [
      { action: 'add-spec', spec: { 'spec-id': nextId, fields } },
      { action: 'set-default-spec', 'spec-id': -1 },
    ],
  }
}

export function defaultPartitionName(transform: string, source: string): string {
  if (transform === 'identity') return source
  if (transform.startsWith('bucket')) return `${source}_bucket`
  if (transform.startsWith('truncate')) return `${source}_trunc`
  if (transform === 'void') return `${source}_null`
  return `${source}_${transform}`
}

/** Transforms applicable to a source column type. */
export function transformsFor(type: string): string[] {
  const temporal = /^(date|timestamp|timestamptz|timestamp_ns|timestamptz_ns)$/.test(type)
  const out = ['identity']
  if (/^(int|long|decimal|date|time|timestamp|string|uuid|fixed|binary)/.test(type)) out.push('bucket')
  if (/^(int|long|decimal|string|binary)/.test(type)) out.push('truncate')
  if (temporal) out.push('year', 'month', 'day')
  if (temporal && type !== 'date') out.push('hour')
  out.push('void')
  return out
}

// ---------------------------------------------------------------- sort order

export function sortChange(md: TableMetadata, id: TableIdentifier, fields: SortField[]): TableChange {
  const names = fieldNames(currentSchema(md)!)
  const nextId = Math.max(1, maxOf((md['sort-orders'] ?? []).map((o) => o['order-id'])) + 1)
  const label = fields.length ? fields.map((f) => `${transformLabel(f.transform, names.get(f['source-id']) ?? '?')} ${f.direction}`).join(', ') : 'unsorted'
  return {
    identifier: id,
    kind: 'sort',
    summary: `Sort order → ${label}`,
    requirements: [uuidReq(md), { type: 'assert-default-sort-order-id', 'default-sort-order-id': md['default-sort-order-id'] ?? 0 }],
    updates: [
      { action: 'add-sort-order', 'sort-order': { 'order-id': fields.length ? nextId : 0, fields } },
      { action: 'set-default-sort-order', 'sort-order-id': -1 },
    ],
  }
}

// ---------------------------------------------------------------- snapshots & refs

export function rollbackChange(md: TableMetadata, id: TableIdentifier, snapshotId: Int64): TableChange {
  const main = md.refs?.main
  return {
    identifier: id,
    kind: 'ref:main',
    summary: `Roll back main to snapshot ${snapshotId}`,
    requirements: [uuidReq(md), { type: 'assert-ref-snapshot-id', ref: 'main', 'snapshot-id': main?.['snapshot-id'] ?? md['current-snapshot-id'] ?? null }],
    updates: [{ action: 'set-snapshot-ref', 'ref-name': 'main', type: 'branch', 'snapshot-id': snapshotId, ...retention(main) }],
  }
}

export interface RefRetention {
  'min-snapshots-to-keep'?: number
  'max-snapshot-age-ms'?: number
  'max-ref-age-ms'?: number
}

function retention(r?: RefRetention): RefRetention {
  const out: RefRetention = {}
  if (r?.['min-snapshots-to-keep'] != null) out['min-snapshots-to-keep'] = r['min-snapshots-to-keep']
  if (r?.['max-snapshot-age-ms'] != null) out['max-snapshot-age-ms'] = r['max-snapshot-age-ms']
  if (r?.['max-ref-age-ms'] != null) out['max-ref-age-ms'] = r['max-ref-age-ms']
  return out
}

export const REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function createRefChange(md: TableMetadata, id: TableIdentifier, name: string, type: 'branch' | 'tag', snapshotId: Int64, r: RefRetention): TableChange {
  return {
    identifier: id,
    kind: `ref:${name}`,
    summary: `Create ${type} ${name} at ${snapshotId}`,
    requirements: [uuidReq(md), { type: 'assert-ref-snapshot-id', ref: name, 'snapshot-id': null }],
    updates: [{ action: 'set-snapshot-ref', 'ref-name': name, type, 'snapshot-id': snapshotId, ...retention(r) }],
  }
}

export function updateRefChange(md: TableMetadata, id: TableIdentifier, name: string, r: RefRetention): TableChange {
  const ref = md.refs?.[name]
  if (!ref) throw new Error(`unknown reference ${name}`)
  return {
    identifier: id,
    kind: `ref:${name}`,
    summary: `Update retention of ${name}`,
    requirements: [uuidReq(md), { type: 'assert-ref-snapshot-id', ref: name, 'snapshot-id': ref['snapshot-id'] }],
    updates: [{ action: 'set-snapshot-ref', 'ref-name': name, type: ref.type, 'snapshot-id': ref['snapshot-id'], ...retention(r) }],
  }
}

export function removeRefChange(md: TableMetadata, id: TableIdentifier, name: string): TableChange {
  const ref = md.refs?.[name]
  if (!ref) throw new Error(`unknown reference ${name}`)
  if (name === 'main') throw new Error('The main branch cannot be removed')
  return {
    identifier: id,
    kind: `ref:${name}`,
    summary: `Remove ${ref.type} ${name}`,
    requirements: [uuidReq(md), { type: 'assert-ref-snapshot-id', ref: name, 'snapshot-id': ref['snapshot-id'] }],
    updates: [{ action: 'remove-snapshot-ref', 'ref-name': name }],
  }
}

export function upgradeFormatChange(md: TableMetadata, id: TableIdentifier, version: number): TableChange {
  if (version <= md['format-version']) throw new Error('Format version can only be upgraded')
  return { identifier: id, kind: 'format', summary: `Upgrade format v${md['format-version']} → v${version}`, requirements: [uuidReq(md)], updates: [{ action: 'upgrade-format-version', 'format-version': version }] }
}

// ---------------------------------------------------------------- change sets

const reqKey = (r: Requirement) => `${r.type}|${String(r.ref ?? '')}`
const sameTable = (a: TableIdentifier, b: TableIdentifier) => a.name === b.name && a.namespace.join('\u001f') === b.namespace.join('\u001f')

/**
 * Adds a change to a change set. Property changes to the same table merge;
 * any other kind may be staged once per table (a second schema change built
 * from the same base would silently drop the first one).
 */
export function stageChange(set: TableChange[], change: TableChange): TableChange[] {
  const existing = set.findIndex((c) => sameTable(c.identifier, change.identifier) && c.kind === change.kind)
  if (existing === -1) return [...set, change]
  if (change.kind !== 'properties') throw new Error(`A ${change.kind.startsWith('ref:') ? 'change to this reference' : `${change.kind} change`} is already staged for ${change.identifier.name}. Apply or discard it first.`)
  const prev = set[existing]
  const merged: TableChange = {
    ...prev,
    summary: `${prev.summary}; ${change.summary.replace(/^Properties: /, '')}`,
    requirements: [...prev.requirements, ...change.requirements.filter((r) => !prev.requirements.some((p) => reqKey(p) === reqKey(r)))],
    updates: [...prev.updates, ...change.updates],
  }
  return set.map((c, i) => (i === existing ? merged : c))
}

/** Transaction body: changes to the same table keep their order; requirements are deduplicated per table. */
export function toTransaction(set: TableChange[]) {
  return {
    'table-changes': set.map((c) => ({ identifier: c.identifier, requirements: c.requirements, updates: c.updates })),
  }
}
