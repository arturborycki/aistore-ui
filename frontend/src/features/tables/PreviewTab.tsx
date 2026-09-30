import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, RefreshCw, Rows3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent } from '@/components/ui/dialog'
import { JsonView } from '@/components/ui/json-view'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { previewTable, type PreviewResult } from '@/lib/catalog'
import type { Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'

const LIMITS = [100, 500, 1000]

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function csvEscape(s: string) {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCSV(p: PreviewResult) {
  const lines = [p.schema.map((c) => csvEscape(c.name)).join(',')]
  for (const r of p.rows) lines.push(r.map((v) => csvEscape(cellText(v))).join(','))
  return lines.join('\n')
}

/**
 * Sample rows read by AIStor directly from the table's Parquet files
 * (PreviewTable, requires s3tables:GetTableData). Nothing is cached.
 */
export function PreviewTab({ cluster, wh, ns, table, currentSnapshot }: { cluster: string; wh: string; ns: Namespace; table: string; currentSnapshot?: string }) {
  const [limit, setLimit] = useState(100)
  const [detail, setDetail] = useState<{ col: string; value: unknown } | null>(null)
  const q = useQuery({
    queryKey: [...qk.table(cluster, wh, ns, table), 'preview', limit],
    queryFn: () => previewTable(cluster, wh, ns, table, limit),
    staleTime: 0,
    gcTime: 0,
  })

  const download = () => {
    if (!q.data) return
    const url = URL.createObjectURL(new Blob([toCSV(q.data)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${[wh, ...ns, table].join('.')}-preview.csv`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5 rounded-[var(--radius-control)] bg-surface p-0.5 text-[12px]" role="radiogroup" aria-label="Row limit">
          {LIMITS.map((l) => (
            <button key={l} role="radio" aria-checked={limit === l} onClick={() => setLimit(l)} className={cn('h-7 rounded-[4px] px-3 text-muted tabular', limit === l && 'bg-bg font-medium text-fg shadow-sm')}>
              {l} rows
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cn(q.isFetching && 'animate-spin')} /> Refresh
        </Button>
        <div className="flex-1" />
        {q.data && (
          <span className="text-[12px] text-muted tabular">
            {q.data.row_count.toLocaleString()} rows{currentSnapshot ? ` · current snapshot ${currentSnapshot}` : ''}
          </span>
        )}
        <Button size="sm" variant="outline" onClick={download} disabled={!q.data?.rows.length}>
          <Download /> CSV
        </Button>
      </div>

      {q.isPending && <Skeleton className="h-72 w-full" />}
      {q.isError &&
        (previewUnsupported(q.error) ? (
          <EmptyState title="AIStor cannot preview this table" className="py-10">
            The preview is read by AIStor itself, and this release can only read some table layouts (for example, not tables with delete files
            from merge-on-read deletes). Query the table with Spark, Trino or another engine instead.
            <span className="mt-2 block font-mono text-[11.5px] text-subtle">{(q.error as Error).message}</span>
          </EmptyState>
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ))}
      {q.data && q.data.rows.length === 0 && (
        <EmptyState icon={<Rows3 />} title="No rows">
          {currentSnapshot ? 'The current snapshot contains no rows.' : 'This table has never been written to.'}
        </EmptyState>
      )}
      {q.data && q.data.rows.length > 0 && (
        <div className="max-h-[65vh] overflow-auto rounded-[var(--radius-card)] border border-border">
          <table className="border-collapse text-[12.5px]">
            <thead className="sticky top-0 z-[2] bg-bg-subtle">
              <tr className="border-b border-border">
                <th className="sticky left-0 z-[3] w-12 border-r border-border bg-bg-subtle px-2 text-right text-[11px] font-normal text-subtle">#</th>
                {q.data.schema.map((c) => (
                  <th key={c.name} className="min-w-[120px] max-w-[320px] border-r border-border px-3 py-1.5 text-left align-top last:border-r-0">
                    <div className="font-mono text-[12px] font-medium">{c.name}</div>
                    <div className="truncate font-mono text-[10.5px] font-normal text-subtle" title={c.type}>
                      {c.type}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-bg-subtle">
                  <td className="sticky left-0 z-[1] border-r border-border bg-bg px-2 text-right font-mono text-[11px] text-subtle tabular">{i + 1}</td>
                  {row.map((v, j) => {
                    const complex = v !== null && typeof v === 'object'
                    const text = cellText(v)
                    return (
                      <td key={j} className="max-w-[320px] border-r border-border px-3 py-1 font-mono text-[12px] last:border-r-0">
                        {v === null || v === undefined ? (
                          <span className="italic text-subtle">null</span>
                        ) : complex || text.length > 60 ? (
                          <button type="button" className="block max-w-full truncate text-left hover:text-accent-text" title="Show full value" onClick={() => setDetail({ col: q.data!.schema[j]?.name ?? '', value: v })}>
                            {text}
                          </button>
                        ) : (
                          <span className={cn('whitespace-nowrap', (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(text)) && 'tabular')}>{text}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        {detail && (
          <DialogContent title={<span className="font-mono">{detail.col}</span>} wide>
            <DialogBody>
              {typeof detail.value === 'object' ? <JsonView value={detail.value} defaultDepth={4} /> : <pre className="whitespace-pre-wrap break-all font-mono text-[12.5px]">{String(detail.value)}</pre>}
            </DialogBody>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

/** AIStor reports reader limitations as a 500 with "not implemented" or a read-batch cause. */
function previewUnsupported(e: unknown): boolean {
  return e instanceof ApiError && e.status === 500 && /not implemented|read batch|scan table/i.test(e.message)
}
