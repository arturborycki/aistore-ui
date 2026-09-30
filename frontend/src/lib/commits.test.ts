import { describe, expect, it } from 'vitest'
import type { NestedField, TableMetadata } from './iceberg'
import { stringifyJSON } from './json'
import {
  assignPartitionFieldIds,
  createRefChange,
  propertiesChange,
  removeRefChange,
  removeSnapshotsChange,
  rollbackChange,
  schemaChange,
  sortChange,
  specChange,
  stageChange,
  toTransaction,
  transformsFor,
  upgradeFormatChange,
} from './commits'
import { canPromote, droppedIds, identifierCandidates, fieldFromIceberg, newField, toIcebergFields, validateFields } from './schemaModel'

const md = {
  'format-version': 2,
  'table-uuid': 'u-1',
  location: 's3://w/t',
  'last-updated-ms': 1,
  'last-column-id': 3,
  'current-schema-id': 0,
  schemas: [
    {
      type: 'struct',
      'schema-id': 0,
      'identifier-field-ids': [1],
      fields: [
        { id: 1, name: 'id', type: 'long', required: true },
        { id: 2, name: 'ts', type: 'timestamptz', required: false },
        { id: 3, name: 'n', type: 'int', required: false },
      ],
    },
  ],
  'default-spec-id': 0,
  'partition-specs': [{ 'spec-id': 0, fields: [{ name: 'ts_day', transform: 'day', 'source-id': 2, 'field-id': 1000 }] }],
  'last-partition-id': 1000,
  'default-sort-order-id': 0,
  'sort-orders': [{ 'order-id': 0, fields: [] }],
  'current-snapshot-id': '1559874333001450338',
  refs: { main: { 'snapshot-id': '1559874333001450338', type: 'branch' }, t1: { 'snapshot-id': '99', type: 'tag' } },
  snapshots: [],
} as unknown as TableMetadata
const id = { namespace: ['ns'], name: 't' }

describe('schema evolution', () => {
  const orig = md.schemas[0].fields.map(fieldFromIceberg)
  it('keeps existing ids and assigns new ids after last-column-id', () => {
    const edited = [...orig, newField('note')]
    const { fields, lastId } = toIcebergFields(edited, md['last-column-id'] + 1)
    expect(fields.map((f) => f.id)).toEqual([1, 2, 3, 4])
    expect(lastId).toBe(4)
    const ch = schemaChange(md, id, fields, lastId, 'add note')
    expect(ch.requirements).toContainEqual({ type: 'assert-current-schema-id', 'current-schema-id': 0 })
    expect(ch.requirements).toContainEqual({ type: 'assert-last-assigned-field-id', 'last-assigned-field-id': 3 })
    expect(ch.updates[0]).toMatchObject({ action: 'add-schema', 'last-column-id': 4, schema: { 'schema-id': 1, 'identifier-field-ids': [1] } })
    expect(ch.updates[1]).toEqual({ action: 'set-current-schema', 'schema-id': -1 })
  })
  it('enforces evolution rules', () => {
    const bad = [
      { ...orig[0] },
      { ...orig[1], required: true }, // optional → required
      { ...orig[2], type: { kind: 'primitive' as const, name: 'string' } }, // int → string
      { ...newField('x'), required: true }, // new required
    ]
    const msgs = validateFields(bad, { evolution: true }).map((p) => p.message).join('\n')
    expect(msgs).toMatch(/cannot become required/)
    expect(msgs).toMatch(/int → string is not an allowed type promotion/)
    expect(msgs).toMatch(/new columns must be optional/)
    expect(canPromote('int', 'long', 2)).toBe(true)
    expect(canPromote('decimal(10, 2)', 'decimal(12, 2)', 2)).toBe(true)
    expect(canPromote('decimal(10, 2)', 'decimal(12, 3)', 2)).toBe(false)
    expect(canPromote('date', 'timestamp', 2)).toBe(false)
    expect(canPromote('date', 'timestamp', 3)).toBe(true)
  })
  it('detects dropped columns', () => {
    expect(droppedIds(md.schemas[0], [orig[0], orig[2]])).toEqual([2])
  })
})

describe('partitioning and sorting', () => {
  it('reuses field ids for known (source, transform) pairs', () => {
    const f = assignPartitionFieldIds(md, [
      { sourceId: 2, transform: 'day', name: 'ts_day' },
      { sourceId: 1, transform: 'bucket[16]', name: 'id_bucket' },
    ])
    expect(f.map((x) => x['field-id'])).toEqual([1000, 1001])
    const ch = specChange(md, id, f)
    expect(ch.summary).toBe('Partitioning → day(ts), bucket(16, id)')
    expect(ch.requirements).toContainEqual({ type: 'assert-last-assigned-partition-id', 'last-assigned-partition-id': 1000 })
  })
  it('offers only valid transforms', () => {
    expect(transformsFor('timestamptz')).toContain('hour')
    expect(transformsFor('date')).not.toContain('hour')
    expect(transformsFor('boolean')).toEqual(['identity', 'void'])
  })
  it('builds sort orders; an empty order is id 0', () => {
    expect(sortChange(md, id, []).updates[0]).toMatchObject({ 'sort-order': { 'order-id': 0 } })
    expect(sortChange(md, id, [{ transform: 'identity', 'source-id': 2, direction: 'desc', 'null-order': 'nulls-last' }]).updates[0]).toMatchObject({ 'sort-order': { 'order-id': 1 } })
  })
})

describe('refs and snapshots', () => {
  it('rollback asserts the current main and serialises 64-bit ids as numbers', () => {
    const ch = rollbackChange(md, id, '1315409071128668664')
    const json = stringifyJSON(ch)
    expect(json).toContain('"snapshot-id":1559874333001450338')
    expect(json).toContain('"snapshot-id":1315409071128668664')
  })
  it('creating a ref asserts it does not exist', () => {
    expect(createRefChange(md, id, 'audit', 'branch', '99', { 'min-snapshots-to-keep': 3 }).requirements[1]).toEqual({ type: 'assert-ref-snapshot-id', ref: 'audit', 'snapshot-id': null })
  })
  it('main cannot be removed', () => {
    expect(() => removeRefChange(md, id, 'main')).toThrow()
    expect(removeRefChange(md, id, 't1').updates[0]).toEqual({ action: 'remove-snapshot-ref', 'ref-name': 't1' })
  })
  it('format can only go up', () => {
    expect(() => upgradeFormatChange(md, id, 2)).toThrow()
    expect(upgradeFormatChange(md, id, 3).updates[0]).toEqual({ action: 'upgrade-format-version', 'format-version': 3 })
  })
})

describe('change sets', () => {
  it('merges property changes and refuses a second schema change', () => {
    let set = stageChange([], propertiesChange(md, id, { a: '1' }, []))
    set = stageChange(set, propertiesChange(md, id, { b: '2' }, ['c']))
    expect(set).toHaveLength(1)
    expect(set[0].requirements).toHaveLength(1)
    expect(set[0].updates).toHaveLength(3)
    set = stageChange(set, schemaChange(md, id, md.schemas[0].fields, 3, 's'))
    expect(() => stageChange(set, schemaChange(md, id, md.schemas[0].fields, 3, 's2'))).toThrow(/already staged/)
    const other = { namespace: ['ns'], name: 'u' }
    set = stageChange(set, propertiesChange({ ...md, 'table-uuid': 'u-2' }, other, { a: '1' }, []))
    expect(toTransaction(set)['table-changes'].map((c) => c.identifier.name)).toEqual(['t', 't', 'u'])
  })
})

describe('snapshot expiry and row keys', () => {
  const withSnaps = {
    ...md,
    'current-snapshot-id': '9007199254740993',
    snapshots: [
      { 'snapshot-id': '9007199254740991', 'timestamp-ms': 1, summary: { operation: 'append' } },
      { 'snapshot-id': '9007199254740992', 'timestamp-ms': 2, summary: { operation: 'append' } },
      { 'snapshot-id': '9007199254740993', 'timestamp-ms': 3, summary: { operation: 'append' } },
    ],
    refs: { main: { 'snapshot-id': '9007199254740993', type: 'branch' }, v1: { 'snapshot-id': '9007199254740992', type: 'tag' } },
  } as unknown as TableMetadata
  const id = { namespace: ['ns'], name: 't' }

  it('removes unreferenced snapshots with exact 64-bit ids and asserts every ref', () => {
    const c = removeSnapshotsChange(withSnaps, id, ['9007199254740991'])
    expect(stringifyJSON(c.updates)).toBe('[{"action":"remove-snapshots","snapshot-ids":[9007199254740991]}]')
    expect(c.requirements.filter((r) => r.type === 'assert-ref-snapshot-id').map((r) => r.ref)).toEqual(['main', 'v1'])
  })

  it('refuses to remove referenced snapshots', () => {
    expect(() => removeSnapshotsChange(withSnaps, id, ['9007199254740992'])).toThrow(/referenced/)
    expect(() => removeSnapshotsChange(withSnaps, id, [])).toThrow()
  })

  it('replaces identifier fields only when asked', () => {
    const fields = md.schemas[0].fields
    const keep = schemaChange(md, id, fields, 3, 's')
    expect((keep.updates[0].schema as { 'identifier-field-ids'?: number[] })['identifier-field-ids']).toEqual([1])
    const none = schemaChange(md, id, fields, 3, 's', [])
    expect((none.updates[0].schema as { 'identifier-field-ids'?: number[] })['identifier-field-ids']).toBeUndefined()
  })
})

describe('identifier candidates', () => {
  it('accepts required primitives through required structs only', () => {
    const fields = [
      { id: 1, name: 'id', type: 'long', required: true },
      { id: 2, name: 'score', type: 'double', required: true },
      { id: 3, name: 'opt', type: 'string', required: false },
      { id: 4, name: 'k', type: { type: 'struct', fields: [{ id: 5, name: 'region', type: 'string', required: true }] }, required: true },
      { id: 6, name: 'o', type: { type: 'struct', fields: [{ id: 7, name: 'x', type: 'int', required: true }] }, required: false },
      { id: 8, name: 'l', type: { type: 'list', 'element-id': 9, element: 'int', 'element-required': true }, required: true },
    ] as NestedField[]
    expect(identifierCandidates(fields)).toEqual([
      { id: 1, path: 'id' },
      { id: 5, path: 'k.region' },
    ])
  })
})
