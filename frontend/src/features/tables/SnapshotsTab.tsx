import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Eye, ChevronRight, Ellipsis, GitBranch, History, Pencil, Plus, Tag, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown'
import type { Int64 } from '@/lib/json'
import { Badge, type Tone } from '@/components/ui/badge'
import { CopyButton } from '@/components/ui/copy-button'
import { Card, CardHeader, KeyValue } from '@/components/ui/layout'
import { EmptyState } from '@/components/ui/states'
import { Checkbox } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { formatBytes, formatCompact, formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { shortId, snapshotTimeline, summaryNumber, type SnapshotRef, type TableMetadata } from '@/lib/iceberg'

const opTone: Record<string, Tone> = { append: 'success', overwrite: 'warning', delete: 'danger', replace: 'info' }

function duration(ms?: number) {
  if (ms == null) return '—'
  const h = ms / 3_600_000
  return h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`
}

/** Single-series line chart of total records over time, with a crosshair tooltip. */
function RecordsChart({ points }: { points: { t: number; v: number; id: string }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [hover, setHover] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const H = 150
  const m = { l: 52, r: 16, t: 12, b: 26 }
  const t0 = points[0]?.t ?? 0
  const t1 = points[points.length - 1]?.t ?? 1
  const vmax = Math.max(1, ...points.map((p) => p.v))
  const nice = Math.pow(10, Math.floor(Math.log10(vmax)))
  const ymax = Math.ceil(vmax / nice) * nice
  const x = (t: number) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (width - m.l - m.r)
  const y = (v: number) => m.t + (1 - v / ymax) * (H - m.t - m.b)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const ticks = [0, ymax / 2, ymax]
  const hp = hover != null ? points[hover] : null
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={`Total records over ${points.length} snapshots, from ${formatNumber(points[0]?.v)} to ${formatNumber(points[points.length - 1]?.v)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const px = e.nativeEvent.offsetX
          let best = 0
          points.forEach((p, i) => {
            if (Math.abs(x(p.t) - px) < Math.abs(x(points[best].t) - px)) best = i
          })
          setHover(best)
        }}
      >
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={m.l} x2={width - m.r} y1={y(tv)} y2={y(tv)} className="stroke-border" strokeWidth={1} />
            <text x={m.l - 8} y={y(tv) + 4} textAnchor="end" className="fill-subtle text-[11px] tabular">
              {formatCompact(tv)}
            </text>
          </g>
        ))}
        <text x={m.l} y={H - 6} className="fill-subtle text-[11px]">
          {dateFmt.format(t0)}
        </text>
        <text x={width - m.r} y={H - 6} textAnchor="end" className="fill-subtle text-[11px]">
          {dateFmt.format(t1)}
        </text>
        <path d={path} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={m.t} y2={H - m.b} className="stroke-border-strong" strokeDasharray="3 3" />
            <circle cx={x(hp.t)} cy={y(hp.v)} r={4.5} className="fill-accent stroke-bg" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute z-10 rounded-[6px] border border-border bg-bg px-2.5 py-1.5 text-[12px] shadow-pop"
          style={{ left: Math.min(x(hp.t) + 10, width - 170), top: 4 }}
        >
          <div className="font-medium tabular">{formatNumber(hp.v)} records</div>
          <div className="text-muted">{formatDateTime(hp.t)}</div>
          <div className="font-mono text-[11px] text-subtle">{shortId(hp.id)}</div>
        </div>
      )}
    </div>
  )
}

function RefBadge({ name, r }: { name: string; r: SnapshotRef }) {
  return (
    <Badge tone={r.type === 'branch' ? 'accent' : 'neutral'} mono>
      {r.type === 'branch' ? <GitBranch className="size-3" /> : <Tag className="size-3" />}
      {name}
    </Badge>
  )
}

export interface SnapshotActions {
  onRollback: (id: Int64) => void
  onCreateRef: (id: Int64) => void
  onEditRef: (name: string) => void
  onRemoveRef: (name: string) => void
  onExpire: (ids: Int64[]) => void
  onViewAt: (id: Int64) => void
}

export function SnapshotsTab({ md, actions }: { md: TableMetadata; actions?: SnapshotActions }) {
  const timeline = useMemo(() => snapshotTimeline(md), [md])
  const [open, setOpen] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Snapshots a branch or tag points at (including main's current one) cannot be expired.
  const pinned = useMemo(() => new Set([...Object.values(md.refs ?? {}).map((r) => String(r['snapshot-id'])), String(md['current-snapshot-id'])]), [md])
  const expirable = timeline.filter(({ snapshot: s }) => !pinned.has(String(s['snapshot-id'])))
  const stopSelecting = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  const points = useMemo(
    () =>
      [...timeline]
        .reverse()
        .map(({ snapshot: s }) => ({ t: s['timestamp-ms'], v: summaryNumber(s, 'total-records') ?? NaN, id: String(s['snapshot-id']) }))
        .filter((p) => !Number.isNaN(p.v)),
    [timeline],
  )
  const refs = Object.entries(md.refs ?? {}).sort(([a], [b]) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))

  if (timeline.length === 0) {
    return (
      <EmptyState icon={<GitBranch />} title="No snapshots yet">
        This table has never been written to. Its first commit (for example a Spark or PyIceberg append) creates a snapshot.
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Total records" description={`Across ${points.length} snapshots`} />
          <div className="px-3 pb-2 pt-3">{points.length > 1 ? <RecordsChart points={points} /> : <p className="p-4 text-[12.5px] text-subtle">Needs at least two snapshots.</p>}</div>
        </Card>
        <Card>
          <CardHeader title="Branches & tags" description="Named references to snapshots" />
          <table className="w-full text-[12.5px]">
            <tbody>
              {refs.map(([name, r]) => (
                <tr key={name} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">
                    <RefBadge name={name} r={r} />
                  </td>
                  <td className="px-2 font-mono text-[12px] text-muted" title={String(r['snapshot-id'])}>
                    {shortId(r['snapshot-id'])}
                  </td>
                  <td className="px-2 text-right text-[12px] text-subtle">
                    {r['max-ref-age-ms'] != null && <span>expires after {duration(r['max-ref-age-ms'])}</span>}
                    {r['min-snapshots-to-keep'] != null && <span>keeps ≥ {r['min-snapshots-to-keep']} snapshots</span>}
                    {r['max-snapshot-age-ms'] != null && <span> · snapshots ≤ {duration(r['max-snapshot-age-ms'])}</span>}
                  </td>
                  {actions && (
                    <td className="w-10 pr-2 text-right">
                      <Menu>
                        <MenuTrigger asChild>
                          <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${name}`}>
                            <Ellipsis />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem icon={<Pencil />} onSelect={() => actions.onEditRef(name)}>Edit retention…</MenuItem>
                          {name !== 'main' && (
                            <MenuItem icon={<Trash2 />} danger onSelect={() => actions.onRemoveRef(name)}>
                              Remove {r.type}…
                            </MenuItem>
                          )}
                        </MenuContent>
                      </Menu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="History"
          description="Newest first. Each snapshot is an atomic commit."
          actions={
            actions &&
            (selecting ? (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setSelected(selected.size === expirable.length ? new Set() : new Set(expirable.map(({ snapshot: s }) => String(s['snapshot-id']))))}>
                  {selected.size === expirable.length ? 'Clear' : `Select all ${expirable.length}`}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={selected.size === 0}
                  onClick={() => actions.onExpire(timeline.map(({ snapshot: s }) => s['snapshot-id']).filter((id) => selected.has(String(id))))}
                >
                  <Trash2 /> Expire {selected.size || ''}
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Cancel selection" onClick={stopSelecting}>
                  <X />
                </Button>
              </div>
            ) : (
              <Tooltip content={expirable.length ? 'Select snapshots to remove from history' : 'Every snapshot is referenced by a branch or tag'}>
                <span>
                  <Button size="sm" variant="outline" disabled={expirable.length === 0} onClick={() => setSelecting(true)}>
                    <Trash2 /> Expire snapshots…
                  </Button>
                </span>
              </Tooltip>
            ))
          }
        />
        <ol className="relative py-2" aria-label="Snapshot history">
          {timeline.map(({ snapshot: s, refs: rs }, i) => {
            const id = String(s['snapshot-id'])
            const isOpen = open === id
            const op = s.summary?.operation ?? 'unknown'
            const added = summaryNumber(s, 'added-records')
            const deleted = summaryNumber(s, 'deleted-records')
            const files = summaryNumber(s, 'added-data-files')
            return (
              <li key={id} className="relative flex items-start">
                {selecting && (
                  <span className="pl-3 pt-3">
                    <Checkbox
                      label={`Select snapshot ${id}`}
                      disabled={pinned.has(id)}
                      checked={selected.has(id)}
                      onCheckedChange={(v) => {
                        const next = new Set(selected)
                        if (v) next.add(id)
                        else next.delete(id)
                        setSelected(next)
                      }}
                    />
                  </span>
                )}
                <div className="relative min-w-0 flex-1">
                <span className={cn('absolute left-[27px] w-px bg-border', i === 0 ? 'top-5' : 'top-0', i === timeline.length - 1 ? 'h-5' : 'h-full')} aria-hidden />
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : id)}
                  aria-expanded={isOpen}
                  className="relative flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-bg-subtle"
                >
                  <span
                    className={cn(
                      'relative z-[1] mt-1 size-[9px] shrink-0 rounded-full ring-4 ring-bg',
                      { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-info', neutral: 'bg-border-strong', accent: 'bg-accent' }[opTone[op] ?? 'neutral'],
                    )}
                    style={{ marginLeft: 3 }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={opTone[op] ?? 'neutral'}>{op}</Badge>
                      <Tooltip content={formatDateTime(s['timestamp-ms'])}>
                        <span className="text-[12.5px] font-medium">{formatRelative(s['timestamp-ms'])}</span>
                      </Tooltip>
                      <span className="font-mono text-[11.5px] text-subtle">{id}</span>
                      {rs.map(({ name, ref }) => (
                        <RefBadge key={name} name={name} r={ref} />
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-muted tabular">
                      {added != null && added > 0 && <span className="text-success">+{formatNumber(added)} records</span>}
                      {deleted != null && deleted > 0 && <span className="text-danger">−{formatNumber(deleted)} records</span>}
                      {files != null && <span>{formatNumber(files)} files added</span>}
                      {summaryNumber(s, 'total-records') != null && <span>{formatNumber(summaryNumber(s, 'total-records'))} total</span>}
                      {summaryNumber(s, 'total-files-size') != null && <span>{formatBytes(summaryNumber(s, 'total-files-size'))}</span>}
                    </div>
                  </div>
                  <ChevronRight className={cn('mt-1 size-4 shrink-0 text-subtle transition-transform', isOpen && 'rotate-90')} />
                </button>
                {isOpen && (
                  <div className="mb-2 ml-12 mr-4 rounded-[var(--radius-control)] border border-border bg-bg-subtle p-3 animate-slide-in">
                    {actions && (
                      <div className="mb-3 flex flex-wrap gap-2">
                        {String(md['current-snapshot-id']) !== id && (
                          <Button size="sm" variant="outline" onClick={() => actions.onRollback(s['snapshot-id'])}>
                            <History /> Roll back main to here
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => actions.onCreateRef(s['snapshot-id'])}>
                          <Plus /> Branch or tag here
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => actions.onViewAt(s['snapshot-id'])}>
                          <Eye /> View table as of here
                        </Button>
                      </div>
                    )}
                    <KeyValue
                      items={[
                        { label: 'Snapshot ID', value: <span className="flex items-center gap-1 font-mono text-[12px]">{id}<CopyButton value={id} /></span> },
                        { label: 'Parent', value: <span className="font-mono text-[12px]">{s['parent-snapshot-id'] != null ? String(s['parent-snapshot-id']) : '—'}</span> },
                        { label: 'Sequence number', value: s['sequence-number'] ?? '—' },
                        { label: 'Schema ID', value: s['schema-id'] ?? '—' },
                        { label: 'Committed', value: formatDateTime(s['timestamp-ms']) },
                        ...(s['manifest-list'] ? [{ label: 'Manifest list', value: <span className="break-all font-mono text-[11.5px]">{s['manifest-list']}</span> }] : []),
                        ...Object.entries(s.summary ?? {})
                          .filter(([k]) => k !== 'operation')
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([k, v]) => ({ label: k, value: <span className="font-mono text-[12px]">{/^\d+$/.test(v) && /size/.test(k) ? `${formatBytes(Number(v))} (${v})` : v}</span> })),
                      ]}
                    />
                  </div>
                )}
                </div>
              </li>
            )
          })}
        </ol>
      </Card>
    </div>
  )
}
