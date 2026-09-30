import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CircleCheck, RefreshCw, Wand2 } from 'lucide-react'
import { Badge, type Tone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/layout'
import { EmptyState, ErrorState, InlineError } from '@/components/ui/states'
import { Checkbox } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import type { Namespace } from '@/lib/namespace'
import { ossie, semanticKeys, type DriftItem, type OssieModel } from '@/lib/ossie'

const kindLabel: Record<DriftItem['kind'], [string, Tone]> = {
  table_moved: ['Table renamed', 'info'],
  table_missing: ['Table dropped', 'danger'],
  untracked: ['Not linked', 'neutral'],
  column_renamed: ['Column renamed', 'info'],
  column_dropped: ['Column dropped', 'danger'],
  type_changed: ['Type changed', 'warning'],
  new_columns: ['New columns', 'success'],
  key_changed: ['Row key changed', 'warning'],
  expression_broken: ['Broken expression', 'danger'],
}

/** Model vs catalog: what changed in the tables and one-click fixes. */
export function SyncPanel({ cluster, wh, ns, name, dirty, onFixed }: { cluster: string; wh: string; ns: Namespace; name: string; dirty: boolean; onFixed: (m: OssieModel) => void }) {
  const q = useQuery({ queryKey: semanticKeys.drift(cluster, wh, ns, name), queryFn: () => ossie.drift(cluster, wh, ns, name) })
  const fixable = (q.data?.items ?? []).filter((i) => i.fix)
  const [chosen, setChosen] = useState<string[] | null>(null)
  const ids = chosen ?? fixable.map((i) => i.id)
  const fix = useMutation({
    mutationFn: () => ossie.fixDrift(cluster, wh, ns, name, ids),
    onSuccess: (r) => {
      onFixed(r.model)
      setChosen(null)
    },
  })
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Catalog sync"
          description="Datasets are linked to tables by UUID and fields to columns by Iceberg field ID, so renames are detected and fixed without guesswork."
          actions={
            <Button size="sm" variant="outline" onClick={() => q.refetch()}>
              <RefreshCw className={cn(q.isFetching && 'animate-spin')} /> Check again
            </Button>
          }
        />
        {q.isPending ? (
          <p className="p-4 text-[12.5px] text-muted">Comparing with the catalog…</p>
        ) : q.data!.items.length === 0 ? (
          <EmptyState icon={<CircleCheck className="text-success" />} title="In sync" className="m-3 border-0">
            Every dataset matches its table.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-border" aria-label="Differences">
              {q.data!.items.map((it) => {
                const [label, tone] = kindLabel[it.kind]
                return (
                  <li key={it.id} className="flex items-start gap-3 px-4 py-2.5">
                    {it.fix ? (
                      <Checkbox label={`Fix: ${it.message}`} checked={ids.includes(it.id)} onCheckedChange={(v) => setChosen(v ? [...ids, it.id] : ids.filter((x) => x !== it.id))} className="mt-0.5" />
                    ) : (
                      <span className="w-4" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={tone}>{label}</Badge>
                        <span className="font-mono text-[12px]">
                          {it.dataset}
                          {it.field ? `.${it.field}` : ''}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[12.5px]">{it.message}</p>
                      <p className="text-[12px] text-muted">{it.fix ? `Fix: ${it.fix}` : 'Needs a manual edit.'}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-2.5">
              {dirty && <span className="mr-auto text-[12px] text-warning">Save or discard your edits first: fixes are computed from the saved version.</span>}
              <InlineError error={fix.error} />
              <Button variant="primary" disabled={dirty || ids.length === 0} loading={fix.isPending} onClick={() => fix.mutate()}>
                <Wand2 /> Apply {ids.length} fix{ids.length === 1 ? '' : 'es'} to the draft
              </Button>
            </div>
          </>
        )}
      </Card>
      {q.data && (
        <Card>
          <CardHeader title="Datasets and their tables" />
          <table className="w-full text-[12.5px]">
            <thead className="bg-bg-subtle text-left text-[11.5px] text-muted">
              <tr>
                <th className="h-8 px-4 font-medium">Dataset</th>
                <th className="px-2 font-medium">Table</th>
                <th className="px-2 font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {q.data.datasets.map((d) => (
                <tr key={d.dataset} className="border-t border-border">
                  <td className="px-4 py-2 font-mono">{d.dataset}</td>
                  <td className="px-2 font-mono">{d.table ?? <span className="font-sans text-muted">{d.reason}</span>}</td>
                  <td className="px-2">{d.tracked ? <Badge tone="success">UUID + field IDs</Badge> : <Badge>by name</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
