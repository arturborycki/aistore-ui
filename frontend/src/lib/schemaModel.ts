/**
 * Editable schema model shared by the create-table builder and the schema
 * evolution editor. Existing fields keep their Iceberg field ids (Iceberg's
 * column identity); new fields get ids only when the schema is built, starting
 * after the table's last-column-id.
 */
import type { IcebergType, NestedField, StructType } from './iceberg'

export type EType =
  | { kind: 'primitive'; name: string }
  | { kind: 'struct'; fields: EField[] }
  | { kind: 'list'; element: EType; elementRequired: boolean; elementId?: number }
  | { kind: 'map'; key: EType; value: EType; valueRequired: boolean; keyId?: number; valueId?: number }

export interface EField {
  uid: string
  /** Iceberg field id; undefined for fields added in this edit */
  id?: number
  name: string
  type: EType
  required: boolean
  doc?: string
  /** the field as it exists in the table (for evolution rules) */
  origin?: NestedField
}

let uidSeq = 0
export const newUid = () => `f${++uidSeq}`

export const PRIMITIVES = [
  'boolean',
  'int',
  'long',
  'float',
  'double',
  'decimal(10, 2)',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'timestamp_ns',
  'timestamptz_ns',
  'string',
  'uuid',
  'fixed[16]',
  'binary',
] as const

export function fromIceberg(t: IcebergType): EType {
  if (typeof t === 'string') return { kind: 'primitive', name: t }
  switch (t.type) {
    case 'struct':
      return { kind: 'struct', fields: t.fields.map(fieldFromIceberg) }
    case 'list':
      return { kind: 'list', element: fromIceberg(t.element), elementRequired: t['element-required'], elementId: t['element-id'] }
    case 'map':
      return { kind: 'map', key: fromIceberg(t.key), value: fromIceberg(t.value), valueRequired: t['value-required'], keyId: t['key-id'], valueId: t['value-id'] }
  }
}

export function fieldFromIceberg(f: NestedField): EField {
  return { uid: newUid(), id: f.id, name: f.name, type: fromIceberg(f.type), required: f.required, doc: f.doc, origin: f }
}

export function newField(name = '', type: EType = { kind: 'primitive', name: 'string' }): EField {
  return { uid: newUid(), name, type, required: false }
}

/** Converts the editable tree to Iceberg, assigning fresh ids (depth-first) to fields without one. */
export function toIcebergFields(fields: EField[], firstFreeId: number): { fields: NestedField[]; lastId: number } {
  let next = firstFreeId
  const take = (existing?: number) => existing ?? next++
  const conv = (t: EType): IcebergType => {
    switch (t.kind) {
      case 'primitive':
        return t.name
      case 'struct':
        return { type: 'struct', fields: t.fields.map(convField) }
      case 'list': {
        const elementId = take(t.elementId)
        return { type: 'list', 'element-id': elementId, element: conv(t.element), 'element-required': t.elementRequired }
      }
      case 'map': {
        const keyId = take(t.keyId)
        const valueId = take(t.valueId)
        return { type: 'map', 'key-id': keyId, key: conv(t.key), 'value-id': valueId, value: conv(t.value), 'value-required': t.valueRequired }
      }
    }
  }
  const convField = (f: EField): NestedField => {
    const id = take(f.id)
    const out: NestedField = { id, name: f.name.trim(), type: 'string', required: f.required }
    if (f.doc?.trim()) out.doc = f.doc.trim()
    out.type = conv(f.type)
    return out
  }
  const out = fields.map(convField)
  return { fields: out, lastId: next - 1 }
}

export function typeText(t: EType): string {
  switch (t.kind) {
    case 'primitive':
      return t.name
    case 'struct':
      return `struct<${t.fields.length}>`
    case 'list':
      return `list<${typeText(t.element)}>`
    case 'map':
      return `map<${typeText(t.key)}, ${typeText(t.value)}>`
  }
}

// ---------------------------------------------------------------- validation

const DECIMAL = /^decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)$/
const FIXED = /^fixed\[(\d+)\]$/

export function validPrimitive(name: string): string | null {
  const d = DECIMAL.exec(name)
  if (d) {
    const p = Number(d[1])
    const s = Number(d[2])
    if (p < 1 || p > 38) return 'Decimal precision must be 1–38'
    if (s > p) return 'Decimal scale cannot exceed precision'
    return null
  }
  const f = FIXED.exec(name)
  if (f) return Number(f[1]) > 0 ? null : 'Fixed length must be positive'
  return (PRIMITIVES as readonly string[]).includes(name) || name === 'variant' || name === 'unknown' ? null : `Unknown type "${name}"`
}

/** Iceberg type promotions allowed during schema evolution. */
export function canPromote(from: string, to: string, formatVersion: number): boolean {
  if (from === to) return true
  if (from === 'int' && to === 'long') return true
  if (from === 'float' && to === 'double') return true
  const a = DECIMAL.exec(from)
  const b = DECIMAL.exec(to)
  if (a && b) return a[2] === b[2] && Number(b[1]) >= Number(a[1])
  if (formatVersion >= 3 && from === 'date' && (to === 'timestamp' || to === 'timestamp_ns')) return true
  return false
}

export interface SchemaProblem {
  uid: string
  message: string
}

/**
 * Validates an edited schema. With `evolution`, applies Iceberg's evolution
 * rules relative to the original fields (no new required columns, no
 * optional→required, only allowed type promotions, no nested kind changes).
 */
export function validateFields(fields: EField[], opts: { evolution?: boolean; formatVersion?: number } = {}): SchemaProblem[] {
  const problems: SchemaProblem[] = []
  const fv = opts.formatVersion ?? 2
  const walk = (fs: EField[], where: string) => {
    if (fs.length === 0) problems.push({ uid: where, message: 'A struct needs at least one field' })
    const seen = new Set<string>()
    for (const f of fs) {
      const n = f.name.trim()
      if (!n) problems.push({ uid: f.uid, message: 'Column name is required' })
      else if (/[.\s]/.test(n) && !opts.evolution) problems.push({ uid: f.uid, message: `"${n}": avoid dots and spaces in column names` })
      if (seen.has(n.toLowerCase())) problems.push({ uid: f.uid, message: `Duplicate column name "${n}"` })
      seen.add(n.toLowerCase())
      if (opts.evolution) {
        if (!f.origin && f.required) problems.push({ uid: f.uid, message: `"${n}": new columns must be optional (existing rows have no value)` })
        if (f.origin && f.required && !f.origin.required) problems.push({ uid: f.uid, message: `"${n}": an optional column cannot become required` })
        if (f.origin) {
          const ot = f.origin.type
          if (typeof ot === 'string') {
            if (f.type.kind !== 'primitive') problems.push({ uid: f.uid, message: `"${n}": cannot change a primitive column into a nested type` })
            else if (!canPromote(ot, f.type.name, fv)) problems.push({ uid: f.uid, message: `"${n}": ${ot} → ${f.type.name} is not an allowed type promotion` })
          } else if (f.type.kind !== ot.type) {
            problems.push({ uid: f.uid, message: `"${n}": cannot change a ${ot.type} into a ${f.type.kind}` })
          }
        }
      }
      checkType(f.type, f.uid)
    }
  }
  const checkType = (t: EType, uid: string) => {
    if (t.kind === 'primitive') {
      const e = validPrimitive(t.name)
      if (e) problems.push({ uid, message: e })
    } else if (t.kind === 'struct') walk(t.fields, uid)
    else if (t.kind === 'list') checkType(t.element, uid)
    else {
      if (t.key.kind !== 'primitive') problems.push({ uid, message: 'Map keys must be a primitive type' })
      checkType(t.key, uid)
      checkType(t.value, uid)
    }
  }
  walk(fields, 'root')
  return problems
}

/** Ids of fields present in `before` but missing from the edited tree. */
export function droppedIds(before: StructType, after: EField[]): number[] {
  const kept = new Set<number>()
  const collect = (fs: EField[]) =>
    fs.forEach((f) => {
      if (f.id != null) kept.add(f.id)
      const t = f.type
      if (t.kind === 'struct') collect(t.fields)
      if (t.kind === 'list' && t.element.kind === 'struct') collect(t.element.fields)
      if (t.kind === 'map' && t.value.kind === 'struct') collect(t.value.fields)
    })
  collect(after)
  const out: number[] = []
  const walk = (fs: NestedField[]) =>
    fs.forEach((f) => {
      if (!kept.has(f.id)) out.push(f.id)
      const t = f.type
      if (typeof t !== 'string') {
        if (t.type === 'struct') walk(t.fields)
        if (t.type === 'list' && typeof t.element !== 'string' && t.element.type === 'struct') walk(t.element.fields)
        if (t.type === 'map' && typeof t.value !== 'string' && t.value.type === 'struct') walk(t.value.fields)
      }
    })
  walk(before.fields)
  return out
}

/**
 * Columns that may be part of the row key (Iceberg identifier fields):
 * required primitives other than float/double, reachable only through
 * required structs (never through lists or maps).
 */
export function identifierCandidates(fields: NestedField[], prefix: string[] = []): { id: number; path: string }[] {
  const out: { id: number; path: string }[] = []
  for (const f of fields) {
    if (!f.required) continue
    const path = [...prefix, f.name]
    if (typeof f.type === 'string') {
      if (f.type !== 'float' && f.type !== 'double') out.push({ id: f.id, path: path.join('.') })
    } else if (f.type.type === 'struct') {
      out.push(...identifierCandidates(f.type.fields, path))
    }
  }
  return out
}
