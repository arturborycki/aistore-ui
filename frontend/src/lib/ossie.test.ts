import { describe, expect, it } from 'vitest'
import {
  completions,
  layoutDiagram,
  metricProblems,
  metricsUsing,
  problemTarget,
  refs,
  removeField,
  renameDataset,
  renameField,
  replaceRefs,
  suggestRelationships,
  withSql,
  withTime,
  isTime,
  type OssieModel,
} from './ossie'

const f = (name: string, datatype?: string) => ({ name, expression: { dialects: [{ dialect: 'ANSI_SQL', expression: name }] }, datatype }) as never

const model = (): OssieModel => ({
  version: '0.2.0.dev0',
  name: 'retail',
  datasets: [
    { name: 'orders', source: 'shop.sales.orders', primary_key: ['order_id'], fields: [f('order_id', 'Integer'), f('customer_id', 'Integer'), f('amount', 'Decimal')] },
    { name: 'customers', source: 'shop.crm.customers', primary_key: ['customer_id'], fields: [f('customer_id', 'Integer'), f('name', 'String')] },
    { name: 'regions', source: 'shop.crm.regions', primary_key: ['id'], fields: [f('id', 'Integer')] },
  ],
  relationships: [{ name: 'oc', from: 'orders', to: 'customers', from_columns: ['customer_id'], to_columns: ['customer_id'] }],
  metrics: [{ name: 'revenue', expression: { dialects: [{ dialect: 'ANSI_SQL', expression: "SUM(orders.amount) + 0 -- orders.x\n + COUNT(DISTINCT customers.customer_id) + 'orders.amount'" }] } }],
})

describe('ossie references', () => {
  it('finds qualified references outside strings and comments', () => {
    const got = refs(model().metrics![0].expression.dialects[0].expression).filter((r) => !r.call && r.parts.length > 1).map((r) => r.parts.join('.'))
    expect(got).toEqual(['orders.amount', 'customers.customer_id'])
  })

  it('rewrites references with quoting where needed', () => {
    expect(replaceRefs('SUM(orders.amount)', (p) => (p[1] === 'amount' ? ['orders', 'net amount'] : null))).toBe('SUM(orders."net amount")')
  })

  it('checks metric references and parentheses', () => {
    const m = model()
    expect(metricProblems(m, 'SUM(orders.amount)')).toEqual([])
    expect(metricProblems(m, 'SUM(orders.amt) + ghost.x + amount')).toEqual(['orders has no field amt', 'Unknown dataset ghost', 'Qualify amount as orders.amount'])
    expect(metricProblems(m, 'SUM(orders.amount')).toContain('Missing )')
  })

  it('completes datasets, then their fields', () => {
    const m = model()
    expect(completions(m, 'SUM(ord', 7).items.map((i) => i.label)).toEqual(['orders'])
    expect(completions(m, 'SUM(orders.am', 13)).toEqual({ from: 11, items: [{ label: 'amount', detail: 'Decimal' }] })
  })
})

describe('cascading edits', () => {
  it('renames a dataset everywhere', () => {
    const m = renameDataset(model(), 'orders', 'sales')
    expect(m.relationships![0].from).toBe('sales')
    expect(m.metrics![0].expression.dialects[0].expression).toContain('SUM(sales.amount)')
    expect(m.metrics![0].expression.dialects[0].expression).toContain("'orders.amount'") // string literal untouched
  })

  it('renames a field in keys, joins and metrics', () => {
    const m = renameField(model(), 'customers', 'customer_id', 'cust_id')
    expect(m.datasets[1].primary_key).toEqual(['cust_id'])
    expect(m.relationships![0].to_columns).toEqual(['cust_id'])
    expect(m.relationships![0].from_columns).toEqual(['customer_id'])
    expect(m.metrics![0].expression.dialects[0].expression).toContain('customers.cust_id')
    expect(metricsUsing(m, 'customers', 'cust_id')).toEqual(['revenue'])
  })

  it('removes a field with the joins and keys that use it', () => {
    const m = removeField(model(), 'orders', 'customer_id')
    expect(m.relationships).toEqual([])
    expect(m.datasets[0].fields!.map((x) => x.name)).toEqual(['order_id', 'amount'])
  })

  it('keeps other dialects when editing SQL and applies is_time defaults', () => {
    const e = withSql({ dialects: [{ dialect: 'DAX', expression: 'x' }] }, 'a')
    expect(e.dialects.map((d) => d.dialect)).toEqual(['ANSI_SQL', 'DAX'])
    const ts = { name: 'ts', expression: e, datatype: 'DateTime' as const }
    expect(isTime(ts)).toBe(true)
    expect(withTime(ts, true).dimension).toBeUndefined()
    expect(withTime(ts, false).dimension).toEqual({ is_time: false })
  })

  it('maps problem paths to editor tabs', () => {
    expect(problemTarget('metrics[3].expression')).toEqual({ tab: 'metrics', index: 3 })
    expect(problemTarget('ai_context')).toEqual({ tab: 'overview' })
  })
})

describe('relationships', () => {
  it('suggests joins to single-column keys, including id → <name>_id', () => {
    const m = model()
    m.datasets[0].fields!.push(f('region_id', 'Integer'))
    const s = suggestRelationships(m)
    expect(s.map((x) => `${x.from}.${x.from_columns[0]}→${x.to}.${x.to_columns[0]}`)).toEqual(['orders.region_id→regions.id'])
  })

  it('lays out one-sides left of many-sides', () => {
    const { nodes } = layoutDiagram(model())
    const x = (n: string) => nodes.find((b) => b.name === n)!.x
    expect(x('customers')).toBeLessThan(x('orders'))
  })
})
