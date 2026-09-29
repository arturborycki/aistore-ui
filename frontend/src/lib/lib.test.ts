import { describe, expect, it } from 'vitest'
import { buildQuery } from './api'
import { formatBytes, humanize } from './format'
import { decodeNamespaceParam, encodeNamespace, validateLevel, WAREHOUSE_NAME_RE } from './namespace'
import { diffProperties, validateDrafts } from '@/features/namespaces/PropertiesEditor'

describe('namespace encoding', () => {
  it('round-trips levels through %1F and escapes separators', () => {
    const ns = ['finance', 'q3 / eu', 'a%b']
    const enc = encodeNamespace(ns)
    expect(enc).toBe('finance%1Fq3%20%2F%20eu%1Fa%25b')
    expect(decodeNamespaceParam(decodeURIComponent(enc))).toEqual(ns)
  })
  it('rejects unsafe level names', () => {
    expect(validateLevel('a/b')).not.toBeNull()
    expect(validateLevel('..')).not.toBeNull()
    expect(validateLevel('ok_name')).toBeNull()
  })
  it('validates warehouse names like AIStor', () => {
    expect(WAREHOUSE_NAME_RE.test('analytics-01')).toBe(true)
    expect(WAREHOUSE_NAME_RE.test('Analytics')).toBe(false)
    expect(WAREHOUSE_NAME_RE.test('ab')).toBe(false)
    expect(WAREHOUSE_NAME_RE.test('-bad')).toBe(false)
  })
})

describe('properties diff', () => {
  const orig = { owner: 'a', env: 'prod', keep: 'x' }
  it('computes updates, renames and removals', () => {
    const drafts = [
      { id: 1, key: 'owner', value: 'b', origKey: 'owner' },
      { id: 2, key: 'environment', value: 'prod', origKey: 'env' },
      { id: 3, key: 'keep', value: 'x', origKey: 'keep', removed: true },
      { id: 4, key: 'new', value: 'v' },
    ]
    const d = diffProperties(orig, drafts)
    expect(d.updates).toEqual({ owner: 'b', environment: 'prod', new: 'v' })
    expect(d.removals.sort()).toEqual(['env', 'keep'])
  })
  it('flags duplicates and oversize values', () => {
    expect(validateDrafts([{ id: 1, key: 'a', value: '' }, { id: 2, key: 'a', value: '' }])).toMatch(/Duplicate/)
    expect(validateDrafts([{ id: 1, key: 'a', value: 'x'.repeat(2049) }])).toMatch(/2048/)
  })
})

describe('helpers', () => {
  it('builds queries skipping empty values', () => {
    expect(buildQuery({ a: 1, b: undefined, c: '', d: true, e: ['x', 'y'] })).toBe('?a=1&d=true&e=x&e=y')
  })
  it('formats bytes and labels', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.50 KiB')
    expect(humanize('icebergCompaction')).toBe('Iceberg compaction')
  })
})
