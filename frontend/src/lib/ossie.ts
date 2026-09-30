/**
 * Apache Ossie semantic models: types, API client and editing helpers.
 * The server validates everything (official schema, structure, catalog);
 * these helpers only make editing pleasant (references, suggestions, layout).
 */
import { api, buildQuery } from './api'
import { encodeNamespace, type Namespace } from './namespace'

export const SPEC_VERSION = '0.2.0.dev0'
export const VENDOR = 'AISTOR_CATALOG'
export const DIALECTS = ['ANSI_SQL', 'SNOWFLAKE', 'DATABRICKS', 'BIGQUERY', 'OSSIE_SQL_2026', 'TABLEAU', 'MDX', 'DAX', 'MAQL', 'SIGMA', 'THOUGHTSPOT'] as const
export const DATATYPES = ['String', 'Integer', 'Decimal', 'Float', 'Boolean', 'Date', 'Time', 'DateTime', 'DateTimeTz', 'Opaque'] as const
export type Datatype = (typeof DATATYPES)[number]

export type AIContext = string | { instructions?: string; synonyms?: string[]; examples?: string[]; [k: string]: unknown }

export interface Extension {
  vendor_name: string
  data: string
}
export interface DialectExpression {
  dialect: string
  expression: string
}
export interface Expression {
  dialects: DialectExpression[]
}
export interface OField {
  name: string
  expression: Expression
  dimension?: { is_time?: boolean }
  label?: string
  description?: string
  datatype?: Datatype
  ai_context?: AIContext
  custom_extensions?: Extension[]
}
export interface ODataset {
  name: string
  source: string
  primary_key?: string[]
  unique_keys?: string[][]
  description?: string
  ai_context?: AIContext
  fields?: OField[]
  custom_extensions?: Extension[]
}
export interface ORelationship {
  name: string
  from: string
  to: string
  from_columns: string[]
  to_columns: string[]
  ai_context?: AIContext
  custom_extensions?: Extension[]
}
export interface OMetric {
  name: string
  expression: Expression
  description?: string
  datatype?: Datatype
  ai_context?: AIContext
  custom_extensions?: Extension[]
}
export interface OssieModel {
  version: string
  name: string
  description?: string
  ai_context?: AIContext
  datasets: ODataset[]
  relationships?: ORelationship[]
  metrics?: OMetric[]
  custom_extensions?: Extension[]
}

export interface Problem {
  severity: 'error' | 'warning'
  path: string
  message: string
}

export interface ModelSummary {
  name: string
  key: string
  warehouse: string
  namespace: string[]
  etag: string
  size: number
  lastModified: string
  description?: string
  datasets: number
  metrics: number
  relationships: number
  tables?: string[]
  invalid?: boolean
}

export interface ModelDoc {
  model: OssieModel | null
  raw?: string
  etag: string
  versionId?: string
  lastModified: string
  editor?: string
  key: string
  problems: Problem[]
}

export interface ModelVersion {
  versionId: string
  etag: string
  size: number
  lastModified: string
  isLatest: boolean
  deleted?: boolean
  editor?: string
}

export interface DriftItem {
  id: string
  kind: 'table_moved' | 'table_missing' | 'untracked' | 'column_renamed' | 'column_dropped' | 'type_changed' | 'new_columns' | 'key_changed' | 'expression_broken'
  dataset: string
  field?: string
  message: string
  fix?: string
}

export interface DatasetStatus {
  dataset: string
  table?: string
  uuid?: string
  tracked: boolean
  moved?: boolean
  reason?: string
}

export interface Usage {
  model: string
  warehouse: string
  namespace: string[]
  dataset: string
  fields: { field: string; fieldId?: number; column?: string }[]
  primaryKey?: string[]
  relationships?: string[]
  metrics?: string[]
}

export interface SemanticHit {
  kind: 'model' | 'dataset' | 'field' | 'metric' | 'relationship'
  warehouse: string
  namespace: string[]
  model: string
  dataset?: string
  name: string
  match?: string
}

// ---------------------------------------------------------------- API

const e = encodeURIComponent
const base = (c: string) => `/api/c/${e(c)}/semantic`
const nsBase = (c: string, wh: string, ns: Namespace) => `${base(c)}/wh/${e(wh)}/ns/${encodeNamespace(ns)}/models`
const modelUrl = (c: string, wh: string, ns: Namespace, m: string) => `${nsBase(c, wh, ns)}/${e(m)}`

export interface TableRef {
  namespace: string[]
  name: string
}

/** Errors from saves carry the server's located problems. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly problems: Problem[],
  ) {
    super(message)
  }
}

async function withProblems<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (err) {
    const problems = (err as { body?: { problems?: Problem[] } }).body?.problems
    if (problems?.length) throw new ModelError((err as Error).message, problems)
    throw err
  }
}

export const ossie = {
  list: async (c: string, wh: string, ns: Namespace) => (await api.get<{ models: ModelSummary[]; truncated: boolean; bucket: string }>(nsBase(c, wh, ns))).data,
  get: async (c: string, wh: string, ns: Namespace, m: string, version?: string) =>
    (await api.get<ModelDoc>(modelUrl(c, wh, ns, m), { query: { version } })).data,
  yamlUrl: (c: string, wh: string, ns: Namespace, m: string, version?: string) => `${modelUrl(c, wh, ns, m)}${buildQuery({ format: 'yaml', version })}`,
  jsonUrl: (c: string, wh: string, ns: Namespace, m: string) => `${modelUrl(c, wh, ns, m)}?format=json`,
  create: (c: string, wh: string, ns: Namespace, body: { name: string; description?: string; tables?: TableRef[]; raw?: string }) =>
    withProblems(api.post<{ etag: string; model: OssieModel; problems: Problem[] }>(nsBase(c, wh, ns), body).then((r) => r.data)),
  save: (c: string, wh: string, ns: Namespace, m: string, model: OssieModel, etag: string) =>
    withProblems(
      api
        .request<{ etag: string; versionId?: string; model: OssieModel; problems: Problem[] }>('PUT', modelUrl(c, wh, ns, m), { body: { model }, headers: { 'If-Match': etag } })
        .then((r) => r.data),
    ),
  remove: async (c: string, wh: string, ns: Namespace, m: string, etag: string) => {
    await api.request('DELETE', modelUrl(c, wh, ns, m), { headers: { 'If-Match': etag } })
  },
  versions: async (c: string, wh: string, ns: Namespace, m: string) => (await api.get<{ versions: ModelVersion[] }>(`${modelUrl(c, wh, ns, m)}/versions`)).data.versions,
  render: async (c: string, model: OssieModel, signal?: AbortSignal) => (await api.post<string>(`${base(c)}/render`, { model }, { text: true, signal })).data,
  yaml: async (c: string, wh: string, ns: Namespace, m: string, version?: string) =>
    (await api.get<string>(modelUrl(c, wh, ns, m), { query: { format: 'yaml', version }, text: true })).data,
  parse: async (c: string, raw: string) => (await api.post<{ model: OssieModel | null; problems: Problem[] }>(`${base(c)}/parse`, { raw })).data,
  validate: async (c: string, model: OssieModel) => (await api.post<{ problems: Problem[] }>(`${base(c)}/validate`, { model })).data.problems,
  generate: async (c: string, wh: string, tables: TableRef[], existing: string[]) =>
    (await api.post<{ datasets: ODataset[] }>(`${base(c)}/generate/wh/${e(wh)}`, { tables, existing })).data.datasets,
  drift: async (c: string, wh: string, ns: Namespace, m: string) =>
    (await api.get<{ etag: string; items: DriftItem[]; datasets: DatasetStatus[] }>(`${modelUrl(c, wh, ns, m)}/drift`)).data,
  fixDrift: async (c: string, wh: string, ns: Namespace, m: string, ids: string[]) =>
    (await api.post<{ etag: string; model: OssieModel; problems: Problem[] }>(`${modelUrl(c, wh, ns, m)}/drift`, { ids })).data,
  usage: async (c: string, wh: string, q: { table?: string; namespace?: Namespace; name?: string }) =>
    (
      await api.get<{ usage: Usage[]; truncated: boolean }>(`${base(c)}/wh/${e(wh)}/usage`, {
        query: { table: q.table, namespace: q.namespace ? q.namespace.join('\u001f') : undefined, name: q.name },
      })
    ).data,
  search: async (c: string, q: string, signal?: AbortSignal) =>
    (await api.get<{ results: SemanticHit[]; truncated: boolean }>(`${base(c)}/search`, { query: { q }, signal })).data,
}

export const semanticKeys = {
  list: (c: string, wh: string, ns: Namespace) => ['semantic', c, wh, ns.join('\u001f'), 'list'] as const,
  model: (c: string, wh: string, ns: Namespace, m: string) => ['semantic', c, wh, ns.join('\u001f'), 'model', m] as const,
  versions: (c: string, wh: string, ns: Namespace, m: string) => ['semantic', c, wh, ns.join('\u001f'), 'model', m, 'versions'] as const,
  drift: (c: string, wh: string, ns: Namespace, m: string) => ['semantic', c, wh, ns.join('\u001f'), 'model', m, 'drift'] as const,
  usage: (c: string, wh: string, table: string) => ['semantic', c, wh, 'usage', table] as const,
}

// ---------------------------------------------------------------- model helpers

export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function sqlOf(e: Expression | undefined): string {
  if (!e) return ''
  return (e.dialects.find((d) => d.dialect === 'ANSI_SQL') ?? e.dialects[0])?.expression ?? ''
}

/** Sets the ANSI_SQL expression, keeping other dialects. */
export function withSql(e: Expression | undefined, sql: string): Expression {
  const others = (e?.dialects ?? []).filter((d) => d.dialect !== 'ANSI_SQL')
  return { dialects: [{ dialect: 'ANSI_SQL', expression: sql }, ...others] }
}

export function aiObject(v: AIContext | undefined): Exclude<AIContext, string> {
  if (!v) return {}
  if (typeof v === 'string') return { instructions: v }
  return v
}

/** Normalises ai_context: drops empty values; undefined when nothing is left. */
export function aiContext(v: Exclude<AIContext, string>): AIContext | undefined {
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    if (x == null || x === '' || (Array.isArray(x) && x.length === 0)) continue
    out[k] = x
  }
  return Object.keys(out).length ? (out as AIContext) : undefined
}

export function synonymsOf(v: AIContext | undefined): string[] {
  return typeof v === 'object' && Array.isArray(v?.synonyms) ? v.synonyms : []
}

export function withSynonyms(v: AIContext | undefined, synonyms: string[]): AIContext | undefined {
  return aiContext({ ...aiObject(v), synonyms })
}

export interface FieldExt {
  fieldId: number
  icebergType?: string
}
export interface DatasetExt {
  tableUuid: string
  warehouse: string
  namespace: string[]
  table: string
  schemaId?: number
}

function ext<T>(exts: Extension[] | undefined): T | undefined {
  const x = exts?.find((e) => e.vendor_name === VENDOR)
  if (!x) return undefined
  try {
    return JSON.parse(x.data) as T
  } catch {
    return undefined
  }
}

export const fieldExt = (f: OField) => ext<FieldExt>(f.custom_extensions)
export const datasetExt = (d: ODataset) => ext<DatasetExt>(d.custom_extensions)

/** Effective time-dimension flag (the spec's default depends on the datatype). */
export function isTime(f: OField): boolean {
  if (f.dimension?.is_time != null) return f.dimension.is_time
  return f.datatype === 'Date' || f.datatype === 'Time' || f.datatype === 'DateTime' || f.datatype === 'DateTimeTz'
}

/** Sets is_time, omitting it when it equals the default. */
export function withTime(f: OField, value: boolean): OField {
  const def = f.datatype === 'Date' || f.datatype === 'Time' || f.datatype === 'DateTime' || f.datatype === 'DateTimeTz'
  const next = { ...f }
  if (value === def) delete next.dimension
  else next.dimension = { is_time: value }
  return next
}

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Stable comparison of two models (for dirty checks). */
export const sameModel = (a: OssieModel | null | undefined, b: OssieModel | null | undefined) => JSON.stringify(a) === JSON.stringify(b)

/** A name unique among `taken` (case-insensitive), derived from `want`. */
export function uniqueName(want: string, taken: string[]): string {
  const base = want.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'item'
  const set = new Set(taken.map((t) => t.toLowerCase()))
  let n = base
  for (let i = 2; set.has(n.toLowerCase()); i++) n = `${base}_${i}`
  return n
}

// ---------------------------------------------------------------- SQL references

export interface Ref {
  parts: string[]
  start: number
  end: number
  call: boolean
}

const identStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c)
const identChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c)

/** Identifier chains in a SQL expression (skips strings, comments, numbers). */
export function refs(expr: string): Ref[] {
  const out: Ref[] = []
  let i = 0
  const n = expr.length
  const ident = (at: number): [string, number] | null => {
    const q = expr[at]
    if (q === '"' || q === '`') {
      const j = expr.indexOf(q, at + 1)
      return j < 0 ? null : [expr.slice(at + 1, j), j + 1]
    }
    if (!identStart(q ?? '')) return null
    let j = at
    while (j < n && identChar(expr[j])) j++
    return [expr.slice(at, j), j]
  }
  while (i < n) {
    const c = expr[i]
    if (c === "'") {
      i++
      while (i < n && !(expr[i] === "'" && expr[i + 1] !== "'")) i += expr[i] === "'" ? 2 : 1
      i++
    } else if (c === '-' && expr[i + 1] === '-') {
      while (i < n && expr[i] !== '\n') i++
    } else if (c === '/' && expr[i + 1] === '*') {
      const j = expr.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
    } else if (/[0-9]/.test(c)) {
      while (i < n && /[A-Za-z0-9_.]/.test(expr[i])) i++
    } else if (identStart(c) || c === '"' || c === '`') {
      const start = i
      const parts: string[] = []
      for (;;) {
        const id = ident(i)
        if (!id) break
        parts.push(id[0])
        i = id[1]
        if (expr[i] === '.' && (identStart(expr[i + 1] ?? '') || expr[i + 1] === '"' || expr[i + 1] === '`')) {
          i++
          continue
        }
        break
      }
      if (!parts.length) {
        i++
        continue
      }
      let j = i
      while (j < n && /\s/.test(expr[j])) j++
      out.push({ parts, start, end: i, call: expr[j] === '(' })
    } else i++
  }
  return out
}

const KEYWORDS = new Set(
  `and or not null is in as case when then else end distinct all any some exists between like ilike true false over partition by
  order asc desc nulls first last rows range unbounded preceding following current row filter where within group interval cast
  try_cast extract from for date time timestamp year quarter month week day hour minute second decimal numeric int integer bigint
  smallint float double real boolean varchar char string text with zone at`.split(/\s+/),
)

export const isKeyword = (s: string) => KEYWORDS.has(s.toLowerCase())

/** Live reference check for a metric: dataset.field must exist. */
export function metricProblems(model: OssieModel, sql: string): string[] {
  const out: string[] = []
  let depth = 0
  for (const ch of sql.replace(/'(?:[^']|'')*'/g, "''")) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth < 0) break
  }
  if (depth !== 0) out.push(depth > 0 ? 'Missing )' : 'Unexpected )')
  for (const r of refs(sql)) {
    if (r.call) continue
    if (r.parts.length === 1) {
      if (isKeyword(r.parts[0])) continue
      const owner = model.datasets.find((d) => d.fields?.some((f) => f.name === r.parts[0]))
      if (owner) out.push(`Qualify ${r.parts[0]} as ${owner.name}.${r.parts[0]}`)
      continue
    }
    const ds = model.datasets.find((d) => d.name === r.parts[0])
    if (!ds) out.push(`Unknown dataset ${r.parts[0]}`)
    else if (ds.fields?.length && !ds.fields.some((f) => f.name === r.parts[1])) out.push(`${ds.name} has no field ${r.parts[1]}`)
  }
  return [...new Set(out)]
}

/** Completion candidates for the token being typed at `pos`. */
export function completions(model: OssieModel, sql: string, pos: number): { from: number; items: { label: string; detail: string }[] } {
  let start = pos
  while (start > 0 && /[A-Za-z0-9_.]/.test(sql[start - 1])) start--
  const word = sql.slice(start, pos)
  const dot = word.indexOf('.')
  if (dot >= 0) {
    const ds = model.datasets.find((d) => d.name === word.slice(0, dot))
    const prefix = word.slice(dot + 1).toLowerCase()
    return {
      from: start + dot + 1,
      items: (ds?.fields ?? []).filter((f) => f.name.toLowerCase().startsWith(prefix)).map((f) => ({ label: f.name, detail: f.datatype ?? '' })),
    }
  }
  const prefix = word.toLowerCase()
  if (!prefix) return { from: pos, items: [] }
  const items = [
    ...model.datasets.filter((d) => d.name.toLowerCase().startsWith(prefix)).map((d) => ({ label: d.name, detail: 'dataset' })),
    ...['SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'COUNT(DISTINCT', 'COALESCE', 'CASE WHEN'].filter((f) => f.toLowerCase().startsWith(prefix)).map((f) => ({ label: f, detail: 'function' })),
  ]
  return { from: start, items }
}

// ---------------------------------------------------------------- relationships

export interface RelSuggestion {
  from: string
  to: string
  from_columns: string[]
  to_columns: string[]
  reason: string
}

const singular = (s: string) => s.toLowerCase().replace(/ies$/, 'y').replace(/(s|es)$/, '')

/**
 * Suggests joins: a field of one dataset that matches another dataset's
 * single-column primary key by name (customer_id ↔ customers.customer_id,
 * or ↔ customers.id) with a compatible type.
 */
export function suggestRelationships(model: OssieModel): RelSuggestion[] {
  const out: RelSuggestion[] = []
  const exists = (s: RelSuggestion) =>
    (model.relationships ?? []).some((r) => r.from === s.from && r.to === s.to && r.from_columns.join() === s.from_columns.join() && r.to_columns.join() === s.to_columns.join())
  for (const to of model.datasets) {
    if (to.primary_key?.length !== 1) continue
    const pk = to.primary_key[0]
    const pkField = to.fields?.find((f) => f.name === pk)
    const names = new Set([pk.toLowerCase()])
    if (pk.toLowerCase() === 'id') names.add(`${singular(to.name)}_id`)
    for (const from of model.datasets) {
      if (from.name === to.name) continue
      for (const f of from.fields ?? []) {
        if (!names.has(f.name.toLowerCase())) continue
        if (pkField?.datatype && f.datatype && pkField.datatype !== f.datatype) continue
        const s = { from: from.name, to: to.name, from_columns: [f.name], to_columns: [pk], reason: `${from.name}.${f.name} matches the key of ${to.name}` }
        if (!exists(s)) out.push(s)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- diagram layout

export interface NodeBox {
  name: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Lays datasets out for the relationship diagram: "one" sides (dimensions)
 * in the left column, then facts, by longest path; rows by order.
 */
export function layoutDiagram(model: OssieModel, opts = { w: 188, rowH: 18, headH: 30, gapX: 90, gapY: 28, maxRows: 6 }): { nodes: NodeBox[]; width: number; height: number } {
  const rels = model.relationships ?? []
  const level = new Map<string, number>()
  for (const d of model.datasets) level.set(d.name, 0)
  for (let pass = 0; pass < model.datasets.length; pass++) {
    let changed = false
    for (const r of rels) {
      const a = level.get(r.to)
      const b = level.get(r.from)
      if (a == null || b == null) continue
      if (b < a + 1 && a + 1 <= model.datasets.length) {
        level.set(r.from, a + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  const cols = new Map<number, string[]>()
  for (const d of model.datasets) {
    const l = level.get(d.name) ?? 0
    cols.set(l, [...(cols.get(l) ?? []), d.name])
  }
  const nodes: NodeBox[] = []
  let height = 0
  const heights = (name: string) => {
    const d = model.datasets.find((x) => x.name === name)!
    const keys = new Set([...(d.primary_key ?? []), ...rels.flatMap((r) => (r.from === name ? r.from_columns : r.to === name ? r.to_columns : []))])
    return opts.headH + Math.min(keys.size || 1, opts.maxRows) * opts.rowH + 8
  }
  ;[...cols.keys()].sort((a, b) => a - b).forEach((l, ci) => {
    let y = 0
    for (const name of cols.get(l)!) {
      const h = heights(name)
      nodes.push({ name, x: ci * (opts.w + opts.gapX), y, w: opts.w, h })
      y += h + opts.gapY
    }
    height = Math.max(height, y - opts.gapY)
  })
  const width = Math.max(1, cols.size) * (opts.w + opts.gapX) - opts.gapX
  return { nodes, width: Math.max(width, opts.w), height: Math.max(height, 60) }
}

// ---------------------------------------------------------------- cascading edits

const quoteIdent = (s: string) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(s) && !isKeyword(s) ? s : `"${s.replace(/"/g, '""')}"`)

/** Rewrites identifier chains in SQL; f returns replacement parts or null. */
export function replaceRefs(sql: string, f: (parts: string[]) => string[] | null): string {
  let out = ''
  let last = 0
  for (const r of refs(sql)) {
    const next = f(r.parts)
    if (!next) continue
    out += sql.slice(last, r.start) + next.map(quoteIdent).join('.')
    last = r.end
  }
  return out + sql.slice(last)
}

function mapMetricSql(m: OssieModel, f: (parts: string[]) => string[] | null): OMetric[] | undefined {
  return m.metrics?.map((mt) => ({
    ...mt,
    expression: { dialects: mt.expression.dialects.map((d) => ({ ...d, expression: replaceRefs(d.expression, f) })) },
  }))
}

/** Renames a dataset and every relationship and metric reference to it. */
export function renameDataset(m: OssieModel, from: string, to: string): OssieModel {
  if (from === to) return m
  return {
    ...m,
    datasets: m.datasets.map((d) => (d.name === from ? { ...d, name: to } : d)),
    relationships: m.relationships?.map((r) => ({ ...r, from: r.from === from ? to : r.from, to: r.to === from ? to : r.to })),
    metrics: mapMetricSql(m, (p) => (p.length >= 2 && p[0] === from ? [to, ...p.slice(1)] : null)),
  }
}

/** Renames a field and its uses in keys, relationships and metrics. */
export function renameField(m: OssieModel, ds: string, from: string, to: string): OssieModel {
  if (from === to) return m
  const swap = (cols?: string[]) => cols?.map((c) => (c === from ? to : c))
  return {
    ...m,
    datasets: m.datasets.map((d) =>
      d.name !== ds
        ? d
        : {
            ...d,
            primary_key: swap(d.primary_key),
            unique_keys: d.unique_keys?.map((k) => swap(k)!),
            fields: d.fields?.map((f) => (f.name === from ? { ...f, name: to } : f)),
          },
    ),
    relationships: m.relationships?.map((r) => ({
      ...r,
      from_columns: r.from === ds ? swap(r.from_columns)! : r.from_columns,
      to_columns: r.to === ds ? swap(r.to_columns)! : r.to_columns,
    })),
    metrics: mapMetricSql(m, (p) => (p.length >= 2 && p[0] === ds && p[1] === from ? [ds, to, ...p.slice(2)] : null)),
  }
}

/** Metrics whose SQL references a dataset (or one of its fields). */
export function metricsUsing(m: OssieModel, ds: string, field?: string): string[] {
  return (m.metrics ?? [])
    .filter((mt) => mt.expression.dialects.some((d) => refs(d.expression).some((r) => r.parts.length >= 2 && r.parts[0] === ds && (!field || r.parts[1] === field))))
    .map((mt) => mt.name)
}

/** Removes a dataset and the relationships that use it (metrics are left for the user to fix). */
export function removeDataset(m: OssieModel, ds: string): OssieModel {
  return { ...m, datasets: m.datasets.filter((d) => d.name !== ds), relationships: m.relationships?.filter((r) => r.from !== ds && r.to !== ds) }
}

/** Removes a field and the keys and relationships that use it. */
export function removeField(m: OssieModel, ds: string, field: string): OssieModel {
  const uses = (cols?: string[]) => !!cols?.includes(field)
  return {
    ...m,
    datasets: m.datasets.map((d) =>
      d.name !== ds
        ? d
        : {
            ...d,
            primary_key: uses(d.primary_key) ? undefined : d.primary_key,
            unique_keys: d.unique_keys?.filter((k) => !uses(k)),
            fields: d.fields?.filter((f) => f.name !== field),
          },
    ),
    relationships: m.relationships?.filter((r) => !((r.from === ds && uses(r.from_columns)) || (r.to === ds && uses(r.to_columns)))),
  }
}

/** Maps a problem path (datasets[2].fields[1]…) to where it is edited. */
export function problemTarget(path: string): { tab: string; index?: number } {
  const m = /^(datasets|metrics|relationships)\[(\d+)\]/.exec(path)
  if (!m) return { tab: path.startsWith('ai_context') || path === 'description' || path === 'name' ? 'overview' : 'yaml' }
  return { tab: m[1], index: Number(m[2]) }
}
