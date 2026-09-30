import { useMemo, useState } from 'react'
import { FileStack, FolderTree, ScrollText, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { StatCard } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Tooltip } from '@/components/ui/tooltip'
import type { InspectFile, InspectManifest, InspectPartition, InspectResult } from '@/lib/catalog'
import { cn } from '@/lib/cn'
import { formatBytes, formatCompact, formatNumber } from '@/lib/format'

const SMALL_FILE = 32 * 1024 * 1024

function rel(path: string, location: string) {
  const base = location.replace(/\/+$/, '') + '/'
  return path.startsWith(base) ? path.slice(base.length) : path
}

function partLabel(p?: { name: string; value: string }[]) {
  return p?.length ? p.map((x) => `${x.name}=${x.value}`).join(', ') : 'unpartitioned'
}

type View = 'partitions' | 'files' | 'manifests'

/**
 * Iceberg "metadata tables" for a snapshot: partitions, data and delete files,
 * and manifests, read from the table's manifest files.
 */
export function FilesTab({ q, location }: { q: { data?: InspectResult; error: unknown; isPending: boolean; refetch: () => void }; location: string }) {
  const [view, setView] = useState<View>('partitions')
  const [filter, setFilter] = useState('')
  const r = q.data
  const f = filter.trim().toLowerCase()

  const partitions = useMemo(() => (r?.partitions ?? []).filter((p) => !f || partLabel(p.values).toLowerCase().includes(f)), [r, f])
  const files = useMemo(() => (r?.files ?? []).filter((x) => !f || x.path.toLowerCase().includes(f) || partLabel(x.partition).toLowerCase().includes(f)), [r, f])
  const manifests = useMemo(() => (r?.manifests ?? []).filter((m) => !f || m.path.toLowerCase().includes(f)), [r, f])

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[74px]" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />
  if (!r || !r.snapshotId) {
    return (
      <EmptyState icon={<FileStack />} title="No data files yet">
        The table has no snapshot. Files appear after the first write.
      </EmptyState>
    )
  }
  const s = r.summary
  const deletes = s.positionDeleteFiles + s.equalityDeleteFiles
  const small = r.files.filter((x) => x.content === 'data' && x.size < SMALL_FILE).length
  const avg = s.dataFiles ? s.dataSize / s.dataFiles : 0

  const partCols: Column<InspectPartition>[] = [
    { key: 'p', header: 'Partition', cell: (p) => <span className="font-mono text-[12px]">{partLabel(p.values)}</span> },
    { key: 'spec', header: 'Spec', width: '70px', cell: (p) => <span className="font-mono text-[12px] text-muted">{p.specId}</span> },
    { key: 'rec', header: 'Records', align: 'right', cell: (p) => <span className="tabular" title={formatNumber(p.records)}>{formatCompact(p.records)}</span> },
    { key: 'files', header: 'Data files', align: 'right', cell: (p) => <span className="tabular">{formatNumber(p.files)}</span> },
    { key: 'size', header: 'Size', align: 'right', cell: (p) => <span className="tabular">{formatBytes(p.size)}</span> },
    { key: 'del', header: 'Delete files', align: 'right', cell: (p) => (p.deleteFiles ? <Badge tone="warning">{p.deleteFiles}</Badge> : <span className="text-subtle">0</span>) },
  ]
  const fileCols: Column<InspectFile>[] = [
    {
      key: 'path',
      header: 'File',
      cell: (x) => (
        <Tooltip content={x.path}>
          <span className="block max-w-[520px] truncate font-mono text-[12px]">{rel(x.path, location)}</span>
        </Tooltip>
      ),
    },
    {
      key: 'content',
      header: 'Content',
      cell: (x) => <Badge tone={x.content === 'data' ? 'neutral' : 'warning'}>{x.content === 'data' ? x.format : x.content.replace('-', ' ')}</Badge>,
    },
    { key: 'part', header: 'Partition', cell: (x) => <span className="font-mono text-[12px] text-muted">{partLabel(x.partition)}</span> },
    { key: 'rec', header: 'Records', align: 'right', cell: (x) => <span className="tabular">{formatNumber(x.records)}</span> },
    { key: 'size', header: 'Size', align: 'right', cell: (x) => <span className={cn('tabular', x.content === 'data' && x.size < SMALL_FILE && 'text-warning')}>{formatBytes(x.size)}</span> },
    { key: 'status', header: 'Status', cell: (x) => <span className="text-[12px] text-muted">{x.status}</span> },
  ]
  const manCols: Column<InspectManifest>[] = [
    {
      key: 'path',
      header: 'Manifest',
      cell: (m) => (
        <Tooltip content={m.path}>
          <span className="block max-w-[460px] truncate font-mono text-[12px]">{rel(m.path, location)}</span>
        </Tooltip>
      ),
    },
    { key: 'c', header: 'Content', cell: (m) => <Badge tone={m.content === 'data' ? 'neutral' : 'warning'}>{m.content}</Badge> },
    { key: 'spec', header: 'Spec', cell: (m) => <span className="font-mono text-[12px] text-muted">{m.specId}</span> },
    { key: 'files', header: 'Files (added / existing / deleted)', align: 'right', cell: (m) => <span className="tabular">{`${m.addedFiles} / ${m.existingFiles} / ${m.deletedFiles}`}</span> },
    { key: 'rows', header: 'Rows added', align: 'right', cell: (m) => <span className="tabular">{formatCompact(m.addedRows)}</span> },
    { key: 'seq', header: 'Seq', align: 'right', cell: (m) => <span className="tabular text-muted">{m.sequenceNumber}</span> },
    { key: 'len', header: 'Size', align: 'right', cell: (m) => <span className="tabular">{formatBytes(m.length)}</span> },
  ]

  const tabs: { id: View; label: string; count: number; icon: React.ReactNode }[] = [
    { id: 'partitions', label: 'Partitions', count: r.partitions.length, icon: <FolderTree className="size-3.5" /> },
    { id: 'files', label: 'Files', count: s.dataFiles + deletes, icon: <FileStack className="size-3.5" /> },
    { id: 'manifests', label: 'Manifests', count: s.manifests, icon: <ScrollText className="size-3.5" /> },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Records" value={<span title={formatNumber(s.records)}>{formatCompact(s.records)}</span>} />
        <StatCard label="Data files" value={formatNumber(s.dataFiles)} hint={`average ${formatBytes(avg)}`} />
        <StatCard label="Data size" value={formatBytes(s.dataSize)} />
        <StatCard label="Delete files" value={formatNumber(deletes)} hint={deletes ? `${formatCompact(s.deleteFileRecords)} deleted rows · ${formatBytes(s.deleteSize)}` : 'none'} />
        <StatCard label="Manifests" value={formatNumber(s.manifests)} hint={s.deleteManifests ? `${s.deleteManifests} for deletes` : undefined} />
        <StatCard label="Partitions" value={formatNumber(r.partitions.length)} />
      </div>
      {(r.truncated || (small > 0 && s.dataFiles > 1) || s.filesWithoutStats > 0) && (
        <ul className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-warning/40 bg-warning-subtle px-3 py-2 text-[12.5px] text-warning">
          {r.truncated && (
            <li className="flex items-center gap-1.5">
              <TriangleAlert className="size-3.5" /> Very large table: only part of the manifests was read, so totals are a sample.
            </li>
          )}
          {small > 0 && s.dataFiles > 1 && (
            <li className="flex items-center gap-1.5">
              <TriangleAlert className="size-3.5" /> {formatNumber(small)} of the listed data files are smaller than 32 MB; compaction would speed up scans.
            </li>
          )}
          {s.filesWithoutStats > 0 && (
            <li className="flex items-center gap-1.5">
              <TriangleAlert className="size-3.5" /> {formatNumber(s.filesWithoutStats)} data files have no column metrics, so column statistics are incomplete.
            </li>
          )}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5 rounded-[var(--radius-control)] bg-surface p-0.5 text-[12px]" role="group" aria-label="Files view">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={view === t.id}
              onClick={() => setView(t.id)}
              className={cn('flex h-7 items-center gap-1.5 rounded-[4px] px-3 text-muted', view === t.id && 'bg-bg font-medium text-fg shadow-sm')}
            >
              {t.icon}
              {t.label}
              <span className="text-subtle tabular">{formatNumber(t.count)}</span>
            </button>
          ))}
        </div>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by path or partition" aria-label="Filter files" className="ml-auto w-72" />
      </div>

      {view === 'partitions' && <DataTable columns={partCols} rows={partitions} rowKey={(p) => `${p.specId}|${partLabel(p.values)}`} empty={<EmptyState title="No partitions match" className="m-3 border-0" />} />}
      {view === 'files' && (
        <>
          <DataTable columns={fileCols} rows={files} rowKey={(x) => x.path} empty={<EmptyState title="No files match" className="m-3 border-0" />} />
          {r.filesTruncated && <p className="text-[12px] text-muted">Showing the first {formatNumber(r.files.length)} files of {formatNumber(s.dataFiles + deletes)}.</p>}
        </>
      )}
      {view === 'manifests' && <DataTable columns={manCols} rows={manifests} rowKey={(m) => m.path} empty={<EmptyState title="No manifests match" className="m-3 border-0" />} />}
      <p className="text-[12px] text-subtle">
        Snapshot <span className="font-mono">{r.snapshotId}</span> · read from its manifest list with your credentials.
      </p>
    </div>
  )
}
