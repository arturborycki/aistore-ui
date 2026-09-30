import { describe, expect, it } from 'vitest'
import { parseJSON, stringifyJSON } from './json'
import { diffSchemas, flattenSchema, resolveView, snapshotTimeline, transformLabel, typeLabel, type Schema, type TableMetadata } from './iceberg'
import { diffLines } from './diff'
import { tokenizeSql } from '@/components/ui/sql-view'

describe('64-bit safe JSON', () => {
  it('keeps snapshot ids exact and round-trips them as JSON integers', () => {
    const text = '{"current-snapshot-id":1559874333001450338,"refs":{"main":{"snapshot-id":1559874333001450338}},"n":5}'
    const v = parseJSON<{ 'current-snapshot-id': string; refs: { main: { 'snapshot-id': string } }; n: number }>(text)
    expect(v['current-snapshot-id']).toBe('1559874333001450338')
    expect(v.refs.main['snapshot-id']).toBe('1559874333001450338')
    expect(v.n).toBe(5)
    expect(stringifyJSON({ 'snapshot-id': '1559874333001450338', ok: '12' })).toBe('{"snapshot-id":1559874333001450338,"ok":"12"}')
  })
})

const s0: Schema = {
  type: 'struct',
  'schema-id': 0,
  fields: [
    { id: 1, name: 'id', type: 'long', required: true },
    { id: 2, name: 'status', type: 'string', required: false },
    { id: 3, name: 'geo', type: { type: 'struct', fields: [{ id: 4, name: 'lat', type: 'float', required: false }] }, required: false },
  ],
}
const s1: Schema = {
  type: 'struct',
  'schema-id': 1,
  fields: [
    { id: 1, name: 'id', type: 'long', required: true },
    { id: 2, name: 'order_status', type: 'string', required: true },
    { id: 3, name: 'geo', type: { type: 'struct', fields: [{ id: 4, name: 'lat', type: 'double', required: false }] }, required: false },
    { id: 5, name: 'tags', type: { type: 'map', 'key-id': 6, key: 'string', 'value-id': 7, value: 'string', 'value-required': false }, required: false },
  ],
}

describe('schemas', () => {
  it('flattens nested types including map key/value', () => {
    const f = flattenSchema(s1)
    expect(f.map((x) => x.path.join('.'))).toEqual(['id', 'order_status', 'geo', 'geo.lat', 'tags', 'tags.key', 'tags.value'])
    expect(typeLabel(s1.fields[3].type)).toBe('map<string, string>')
  })
  it('diffs by field id (rename, promotion, nullability, add)', () => {
    const kinds = diffSchemas(s0, s1).map((c) => c.kind).sort()
    expect(kinds).toEqual(['added', 'added', 'added', 'nullability', 'renamed', 'type'])
  })
  it('labels partition transforms', () => {
    expect(transformLabel('bucket[16]', 'customer_id')).toBe('bucket(16, customer_id)')
    expect(transformLabel('day', 'ts')).toBe('day(ts)')
    expect(transformLabel('identity', 'region')).toBe('region')
  })
  it('orders snapshots newest first and attaches refs', () => {
    const md = {
      snapshots: [
        { 'snapshot-id': '1', 'timestamp-ms': 1, summary: { operation: 'append' } },
        { 'snapshot-id': '2', 'timestamp-ms': 2, summary: { operation: 'append' } },
      ],
      refs: { main: { 'snapshot-id': '2', type: 'branch' } },
    } as unknown as TableMetadata
    const t = snapshotTimeline(md)
    expect(t[0].snapshot['snapshot-id']).toBe('2')
    expect(t[0].refs[0].name).toBe('main')
  })
})

describe('text utilities', () => {
  it('produces a minimal line diff', () => {
    const d = diffLines('a\nb\nc', 'a\nx\nc')
    expect(d.map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'del:b', 'add:x', 'same:c'])
  })
  it('tokenizes SQL keywords, strings and functions', () => {
    const toks = tokenizeSql("SELECT count(*) FROM t WHERE s <> 'x'").filter((t) => t.t !== 'ws')
    expect(toks.find((t) => t.v === 'SELECT')?.t).toBe('kw')
    expect(toks.find((t) => t.v === 'count')?.t).toBe('fn')
    expect(toks.find((t) => t.v === "'x'")?.t).toBe('str')
  })
})

describe('time travel', () => {
  const md = {
    'current-schema-id': 1,
    schemas: [
      { type: 'struct', 'schema-id': 0, fields: [{ id: 1, name: 'id', type: 'long', required: true }] },
      { type: 'struct', 'schema-id': 1, fields: [{ id: 1, name: 'id', type: 'long', required: true }, { id: 2, name: 'x', type: 'int', required: false }] },
    ],
    'current-snapshot-id': '20',
    snapshots: [
      { 'snapshot-id': '10', 'schema-id': 0, 'timestamp-ms': 1, summary: { operation: 'append' } },
      { 'snapshot-id': '20', 'schema-id': 1, 'timestamp-ms': 2, summary: { operation: 'append' } },
    ],
    refs: { main: { 'snapshot-id': '20', type: 'branch' }, old: { 'snapshot-id': '10', type: 'tag' }, dev: { 'snapshot-id': '10', type: 'branch' } },
  } as unknown as TableMetadata

  it('reads tags and snapshots with their own schema, branches with the current one', () => {
    expect(resolveView(md, 'ref:old').schema?.['schema-id']).toBe(0)
    expect(resolveView(md, 'snap:10').schema?.['schema-id']).toBe(0)
    expect(resolveView(md, 'ref:dev').schema?.['schema-id']).toBe(1)
    expect(resolveView(md, 'ref:dev').snapshot?.['snapshot-id']).toBe('10')
  })

  it('falls back to current for main, the current snapshot and unknown selectors', () => {
    for (const at of ['', 'ref:main', 'snap:20', 'snap:99', 'ref:nope', 'garbage']) expect(resolveView(md, at).kind).toBe('current')
  })
})
