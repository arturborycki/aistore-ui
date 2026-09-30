import { useLayoutEffect, useRef, useState } from 'react'
import { Plus, Sigma, Trash2, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Card, CardHeader } from '@/components/ui/layout'
import { EmptyState } from '@/components/ui/states'
import { cn } from '@/lib/cn'
import { completions, DATATYPES, DIALECTS, metricProblems, sqlOf, uniqueName, withSql, type Datatype, type OMetric, type OssieModel, type Problem } from '@/lib/ossie'

const DATALECTS_EXTRA = DIALECTS.filter((d) => d !== 'ANSI_SQL')
import { AIContextEditor } from './AIContextEditor'

/** A SQL textarea that completes dataset and field names as you type. */
export function SqlEditor({ model, value, onChange, label }: { model: OssieModel; value: string; onChange: (v: string) => void; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [menu, setMenu] = useState<{ from: number; items: { label: string; detail: string }[]; active: number } | null>(null)
  // Caret position to restore after an accepted completion, applied in the same
  // commit as the new value so fast typing continues at the right place.
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pendingCaret.current != null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  }, [value])
  const refresh = (text: string, pos: number) => {
    const c = completions(model, text, pos)
    setMenu(c.items.length ? { ...c, active: 0 } : null)
  }
  const accept = (label: string) => {
    const el = ref.current
    if (!el || !menu) return
    const pos = el.selectionStart
    const next = value.slice(0, menu.from) + label + value.slice(pos)
    pendingCaret.current = menu.from + label.length
    onChange(next)
    setMenu(null)
    el.focus()
  }
  const listId = `${label.replace(/\W+/g, '-')}-completions`
  return (
    <div className="relative">
      <Textarea
        ref={ref}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={menu ? listId : undefined}
        aria-expanded={!!menu}
        role="combobox"
        rows={4}
        spellCheck={false}
        value={value}
        className="font-mono text-[12.5px]"
        placeholder="SUM(orders.amount)"
        onChange={(e) => {
          onChange(e.target.value)
          refresh(e.target.value, e.target.selectionStart)
        }}
        onBlur={() => setTimeout(() => setMenu(null), 150)}
        onKeyDown={(e) => {
          if (!menu) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const d = e.key === 'ArrowDown' ? 1 : -1
            setMenu({ ...menu, active: (menu.active + d + menu.items.length) % menu.items.length })
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            accept(menu.items[menu.active].label)
          } else if (e.key === 'Escape') setMenu(null)
        }}
      />
      {menu && (
        <ul id={listId} role="listbox" aria-label="Suggestions" className="absolute left-2 top-full z-20 mt-1 max-h-48 min-w-56 overflow-y-auto rounded-[var(--radius-control)] border border-border bg-bg py-1 shadow-pop">
          {menu.items.map((it, i) => (
            <li
              key={it.label}
              role="option"
              aria-selected={i === menu.active}
              onMouseDown={(e) => {
                e.preventDefault()
                accept(it.label)
              }}
              className={cn('flex cursor-default items-center justify-between gap-4 px-2 py-1 font-mono text-[12px]', i === menu.active && 'bg-surface')}
            >
              {it.label}
              <span className="font-sans text-[11px] text-subtle">{it.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MetricEditor({ model, metric, onChange, onRemove, serverProblems }: { model: OssieModel; metric: OMetric; onChange: (m: OMetric) => void; onRemove: () => void; serverProblems: Problem[] }) {
  const sql = sqlOf(metric.expression)
  const live = metricProblems(model, sql)
  const others = metric.expression.dialects.filter((d) => d.dialect !== 'ANSI_SQL')
  const [nameText, setNameText] = useState(metric.name)
  const clash = nameText !== metric.name && (model.metrics ?? []).some((m) => m.name.toLowerCase() === nameText.toLowerCase())
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Sigma className="size-4 text-accent-text" /> Metric</span>}
        actions={
          <Button size="sm" variant="danger-outline" onClick={onRemove}>
            <Trash2 /> Remove metric
          </Button>
        }
      />
      <div className="grid gap-3 p-4 md:grid-cols-2">
        <Field label="Name" error={clash ? `${nameText} is already used` : !nameText.trim() ? 'A name is required' : null}>
          {(p) => (
            <Input
              {...p}
              value={nameText}
              onChange={(e) => setNameText(e.target.value)}
              onBlur={() => (!clash && nameText.trim() ? onChange({ ...metric, name: nameText.trim() }) : setNameText(metric.name))}
              className="font-mono"
            />
          )}
        </Field>
        <Field label="Datatype">
          {(p) => (
            <select {...p} value={metric.datatype ?? ''} onChange={(e) => onChange({ ...metric, datatype: (e.target.value || undefined) as Datatype | undefined })} className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 text-[12.5px]">
              <option value="">—</option>
              {DATATYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          )}
        </Field>
        <div className="md:col-span-2">
          <Field label="Description">{(p) => <Textarea {...p} rows={2} value={metric.description ?? ''} onChange={(e) => onChange({ ...metric, description: e.target.value || undefined })} />}</Field>
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <span className="text-[12px] font-medium">Expression (ANSI SQL)</span>
          <SqlEditor model={model} label={`Expression of ${metric.name}`} value={sql} onChange={(v) => onChange({ ...metric, expression: withSql(metric.expression, v) })} />
          <p className="text-[11.5px] text-muted">Reference fields as dataset.field. Type a dataset name and a dot for its fields.</p>
          {[...live, ...serverProblems.map((p) => p.message)].filter((v, i, a) => a.indexOf(v) === i).map((m) => (
            <p key={m} className="flex items-center gap-1.5 text-[12px] text-warning">
              <TriangleAlert className="size-3.5" /> {m}
            </p>
          ))}
        </div>
        <div className="flex flex-col gap-2 md:col-span-2">
          <span className="text-[12px] font-medium">Other dialects</span>
          {others.map((d, i) => (
            <div key={i} className="flex items-start gap-2">
              <select
                aria-label={`Dialect ${i + 1}`}
                value={d.dialect}
                onChange={(e) => onChange({ ...metric, expression: { dialects: metric.expression.dialects.map((x) => (x === d ? { ...x, dialect: e.target.value } : x)) } })}
                className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 text-[12px]"
              >
                {DATALECTS_EXTRA.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <Textarea
                aria-label={`${d.dialect} expression`}
                rows={2}
                value={d.expression}
                spellCheck={false}
                className="font-mono text-[12.5px]"
                onChange={(e) => onChange({ ...metric, expression: { dialects: metric.expression.dialects.map((x) => (x === d ? { ...x, expression: e.target.value } : x)) } })}
              />
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${d.dialect} expression`} onClick={() => onChange({ ...metric, expression: { dialects: metric.expression.dialects.filter((x) => x !== d) } })}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const used = new Set(metric.expression.dialects.map((d) => d.dialect))
                const next = DATALECTS_EXTRA.find((d) => !used.has(d))
                if (next) onChange({ ...metric, expression: { dialects: [...metric.expression.dialects, { dialect: next, expression: sql }] } })
              }}
            >
              <Plus /> Add dialect
            </Button>
          </div>
        </div>
        <div className="md:col-span-2">
          <AIContextEditor subject={metric.name} value={metric.ai_context} onChange={(v) => onChange({ ...metric, ai_context: v })} />
        </div>
      </div>
    </Card>
  )
}

export function MetricsPanel({ model, setDraft, problems, selected, onSelect }: { model: OssieModel; setDraft: (f: (m: OssieModel) => OssieModel) => void; problems: Problem[]; selected: number; onSelect: (i: number) => void }) {
  const metrics = model.metrics ?? []
  const idx = Math.min(selected, metrics.length - 1)
  const setMetrics = (f: (m: OMetric[]) => OMetric[]) => setDraft((m) => ({ ...m, metrics: f(m.metrics ?? []) }))
  const add = () => {
    const name = uniqueName('new_metric', metrics.map((m) => m.name))
    setMetrics((m) => [...m, { name, expression: withSql(undefined, '') }])
    onSelect(metrics.length)
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader
          title={`Metrics (${metrics.length})`}
          actions={
            <Button size="sm" variant="outline" onClick={add}>
              <Plus /> Add
            </Button>
          }
        />
        <ul className="p-1.5" aria-label="Metrics">
          {metrics.map((m, i) => {
            const n = problems.filter((p) => p.path.startsWith(`metrics[${i}]`)).length + metricProblems(model, sqlOf(m.expression)).length
            return (
              <li key={i}>
                <button type="button" aria-current={i === idx} onClick={() => onSelect(i)} className={cn('flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left', i === idx ? 'bg-surface' : 'hover:bg-surface')}>
                  <Sigma className="size-3.5 text-accent-text" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{m.name}</span>
                  {m.datatype && <span className="text-[11px] text-subtle">{m.datatype}</span>}
                  {n > 0 && <Badge tone="warning">{n}</Badge>}
                </button>
              </li>
            )
          })}
        </ul>
      </Card>
      {metrics[idx] ? (
        <MetricEditor
          key={idx}
          model={model}
          metric={metrics[idx]}
          serverProblems={problems.filter((p) => p.path.startsWith(`metrics[${idx}]`))}
          onChange={(m) => setMetrics((x) => x.map((y, j) => (j === idx ? m : y)))}
          onRemove={() => setMetrics((x) => x.filter((_, j) => j !== idx))}
        />
      ) : (
        <EmptyState icon={<Sigma />} title="No metrics yet" action={<Button onClick={add}><Plus /> Add metric</Button>}>
          Metrics are aggregates such as SUM(orders.amount), and may combine datasets.
        </EmptyState>
      )}
    </div>
  )
}
