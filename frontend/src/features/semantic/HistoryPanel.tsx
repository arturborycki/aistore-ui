import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History, RotateCcw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DiffView } from '@/components/ui/diff-view'
import { Card, CardHeader } from '@/components/ui/layout'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format'
import type { Namespace } from '@/lib/namespace'
import { ossie, semanticKeys, type OssieModel } from '@/lib/ossie'

/** Object versions of the model file: who saved what, diffs, restore into the draft. */
export function HistoryPanel({ cluster, wh, ns, name, onRestore }: { cluster: string; wh: string; ns: Namespace; name: string; onRestore: (m: OssieModel) => void }) {
  const q = useQuery({ queryKey: semanticKeys.versions(cluster, wh, ns, name), queryFn: () => ossie.versions(cluster, wh, ns, name) })
  const versions = (q.data ?? []).filter((v) => !v.deleted)
  const [sel, setSel] = useState<string>()
  const selected = versions.find((v) => v.versionId === sel) ?? versions[0]
  const idx = selected ? versions.indexOf(selected) : -1
  const prev = idx >= 0 ? versions[idx + 1] : undefined
  const yaml = (v?: string) => ({ queryKey: ['semantic-yaml', cluster, wh, ns.join('\u001f'), name, v ?? 'none'], queryFn: () => ossie.yaml(cluster, wh, ns, name, v), enabled: !!v, staleTime: Infinity })
  const a = useQuery(yaml(prev?.versionId))
  const b = useQuery(yaml(selected?.versionId))
  const [restoring, setRestoring] = useState(false)

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (q.isSuccess && versions.length === 0) {
    return (
      <EmptyState icon={<History />} title="No history">
        The bucket keeps no versions of this file. Enable versioning on the bucket to keep every saved version.
      </EmptyState>
    )
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader title="Versions" description="Newest first. The editor is recorded by this UI." />
        <ol aria-label="Model versions">
          {versions.map((v, i) => (
            <li key={v.versionId}>
              <button
                type="button"
                aria-current={v === selected}
                onClick={() => setSel(v.versionId)}
                className={cn('flex w-full flex-col items-start gap-0.5 border-b border-border px-4 py-2.5 text-left last:border-0 hover:bg-bg-subtle', v === selected && 'bg-accent-subtle/50')}
              >
                <span className="flex items-center gap-2 text-[12.5px] font-medium">
                  <Tooltip content={formatDateTime(v.lastModified)}>
                    <span>{formatRelative(v.lastModified)}</span>
                  </Tooltip>
                  {v.isLatest && <Badge tone="accent">current</Badge>}
                  {i === versions.length - 1 && <Badge>created</Badge>}
                </span>
                <span className="text-[11.5px] text-muted">
                  {v.editor || 'unknown editor'} · {formatBytes(v.size)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </Card>
      <Card>
        <CardHeader
          title={selected ? `Changes in this version` : 'Version'}
          description={selected && (prev ? `Compared with the version from ${formatDateTime(prev.lastModified)}` : 'The first version')}
          actions={
            selected &&
            !selected.isLatest && (
              <Button
                size="sm"
                variant="outline"
                loading={restoring}
                onClick={async () => {
                  setRestoring(true)
                  try {
                    const d = await ossie.get(cluster, wh, ns, name, selected.versionId)
                    if (d.model) onRestore(d.model)
                  } finally {
                    setRestoring(false)
                  }
                }}
              >
                <RotateCcw /> Restore into draft
              </Button>
            )
          }
        />
        {selected && (b.data != null ? <DiffView before={a.data ?? ''} after={b.data} label="Version changes" className="max-h-[65vh]" /> : <p className="p-4 text-[12.5px] text-muted">Loading…</p>)}
      </Card>
    </div>
  )
}
