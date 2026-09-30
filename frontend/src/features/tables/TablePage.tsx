import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import {
  ArrowUpCircle,
  Check,
  ChevronDown,
  Clock,
  GitBranch,
  Tag,
  Ellipsis,
  GitCompare,
  FileJson,
  GitCommitHorizontal,
  Info,
  KeyRound,
  Layers,
  ListTree,
  Lock,
  Pencil,
  RefreshCw,
  Rows3,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyText } from '@/components/ui/copy-button'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown'
import { EntityBadgeIcon } from '@/components/ui/entity-icon'
import { Card, CardHeader, KeyValue, PageHeader, StatCard } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import { TypeChip } from '@/components/ui/type-chip'
import { loadTable, resourceArn } from '@/lib/catalog'
import { propertiesChange } from '@/lib/commits'
import type { Int64 } from '@/lib/json'
import { cn } from '@/lib/cn'
import { formatBytes, formatCompact, formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { currentSchema, fieldNames, resolveView, shortId, summaryNumber, transformLabel, type LoadTableResult, type TableMetadata, type TableView } from '@/lib/iceberg'
import { decodeNamespaceParam, namespaceLabel } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { AccessPanel } from '@/features/warehouses/AccessPanel'
import { PropertiesEditor } from '@/features/namespaces/PropertiesEditor'
import { CommitBar, useTableCommit } from './CommitBar'
import { DropTableDialog, RenameDialog } from './EntityDialogs'
import { EvolvePartitionDialog, EvolveSchemaDialog, EvolveSortDialog, ExpireSnapshotsDialog, RefDialog, RemoveRefDialog, RollbackDialog, UpgradeFormatDialog } from './EvolveDialogs'
import { MaintenanceHealthBadge, MaintenanceTab, useMaintenanceStatus } from './MaintenanceTab'
import { MetadataTab } from './MetadataTab'
import { PartitionsTab } from './PartitionsTab'
import { PreviewTab } from './PreviewTab'
import { SchemaTree } from './SchemaTree'
import { SettingsTab } from './SettingsTab'
import { SnapshotsTab } from './SnapshotsTab'

function OverviewTab({ data, wh, view }: { data: LoadTableResult; wh: string; view: TableView }) {
  const md = data.metadata
  const snap = view.snapshot
  const schema = view.schema
  const names = schema ? fieldNames(schema) : new Map<number, string>()
  const spec = md['partition-specs'].find((s) => s['spec-id'] === md['default-spec-id'])
  const order = md['sort-orders']?.find((o) => o['order-id'] === md['default-sort-order-id'])
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Table" />
        <div className="p-4">
          <KeyValue
            items={[
              { label: 'UUID', value: <CopyText value={md['table-uuid']} /> },
              { label: 'ARN', value: <CopyText value={resourceArn.table(wh, md['table-uuid'])} /> },
              { label: 'Location', value: <CopyText value={md.location} /> },
              { label: 'Format version', value: `v${md['format-version']}` },
              { label: 'Last updated', value: formatDateTime(md['last-updated-ms']) },
              { label: 'Partitioning', value: spec?.fields.length ? <span className="font-mono text-[12px]">{spec.fields.map((f) => transformLabel(f.transform, names.get(f['source-id']) ?? '?')).join(', ')}</span> : 'Unpartitioned' },
              {
                label: 'Sort order',
                value: order?.fields.length ? <span className="font-mono text-[12px]">{order.fields.map((f) => `${transformLabel(f.transform, names.get(f['source-id']) ?? '?')} ${f.direction}`).join(', ')}</span> : 'Unsorted',
              },
              { label: 'File format', value: md.properties?.['write.format.default'] ?? 'parquet' },
            ]}
          />
        </div>
      </Card>
      <Card>
        <CardHeader title={view.kind === 'current' ? 'Current snapshot' : `Snapshot of ${view.label}`} />
        <div className="p-4">
          {snap ? (
            <KeyValue
              items={[
                { label: 'Snapshot ID', value: <CopyText value={String(snap['snapshot-id'])} /> },
                { label: 'Operation', value: <Badge>{snap.summary.operation}</Badge> },
                { label: 'Committed', value: <span title={formatDateTime(snap['timestamp-ms'])}>{formatRelative(snap['timestamp-ms'])}</span> },
                { label: 'Records', value: formatNumber(summaryNumber(snap, 'total-records')) },
                { label: 'Data files', value: formatNumber(summaryNumber(snap, 'total-data-files')) },
                { label: 'Delete files', value: formatNumber(summaryNumber(snap, 'total-delete-files')) },
                { label: 'Size', value: formatBytes(summaryNumber(snap, 'total-files-size')) },
              ]}
            />
          ) : (
            <p className="text-[12.5px] text-subtle">No snapshot yet — the table has not been written to.</p>
          )}
        </div>
      </Card>
      {schema && (
        <Card className="xl:col-span-2">
          <CardHeader title="Columns" description={`Schema ${schema['schema-id']} · ${schema.fields.length} top-level columns`} />
          <div className="flex flex-wrap gap-1.5 p-4">
            {schema.fields.map((f) => (
              <span key={f.id} className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-2 py-1">
                <span className={cn('font-mono text-[12px]', f.required && 'font-semibold')}>{f.name}</span>
                <TypeChip type={f.type} />
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

/** Picks the branch, tag or snapshot the page shows ("time travel"). */
function ViewPicker({ md, view, onChange }: { md: TableMetadata; view: TableView; onChange: (at: string) => void }) {
  const refs = Object.entries(md.refs ?? {}).sort(([a], [b]) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
  const icon = view.kind === 'tag' ? <Tag /> : view.kind === 'snapshot' ? <Clock /> : <GitBranch />
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="outline" aria-label={`Viewing ${view.label}`} className={cn(view.kind !== 'current' && 'border-warning/60 text-warning')}>
          {icon}
          <span className="max-w-40 truncate font-mono text-[12px]">{view.label}</span>
          <ChevronDown className="text-subtle" />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>View table as of</MenuLabel>
        {refs.map(([name, r]) => {
          const at = name === 'main' ? '' : `ref:${name}`
          const active = view.at === at || (name === 'main' && view.kind === 'current')
          return (
            <MenuItem key={name} icon={r.type === 'tag' ? <Tag /> : <GitBranch />} onSelect={() => onChange(at)}>
              <span className="font-mono text-[12px]">{name}</span>
              <span className="ml-3 font-mono text-[11px] text-subtle">{shortId(r['snapshot-id'])}</span>
              {active && <Check className="ml-auto size-3.5 text-accent" />}
            </MenuItem>
          )
        })}
        {view.kind === 'snapshot' && (
          <MenuItem icon={<Clock />} onSelect={() => undefined}>
            <span className="font-mono text-[12px]">{view.label}</span>
            <Check className="ml-auto size-3.5 text-accent" />
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuLabel>Any snapshot: Snapshots tab → “View table as of here”</MenuLabel>
      </MenuContent>
    </Menu>
  )
}

export function TablePage() {
  const cluster = useCluster()
  const params = useParams()
  const wh = params.wh!
  const ns = useMemo(() => decodeNamespaceParam(params.ns), [params.ns])
  const table = params.table!
  const [search, setSearch] = useSearchParams()
  const tab = search.get('tab') ?? 'overview'
  const at = search.get('at') ?? ''
  const setAt = (next: string, tabOverride?: string) => {
    const p: Record<string, string> = { tab: tabOverride ?? tab }
    if (next) p.at = next
    setSearch(p, { replace: true })
  }
  const navigate = useNavigate()
  const [renaming, setRenaming] = useState(false)
  const [dropping, setDropping] = useState(false)
  type DialogState =
    | { kind: 'schema' | 'spec' | 'sort' | 'upgrade' }
    | { kind: 'rollback'; snapshot: Int64 }
    | { kind: 'ref'; snapshot?: Int64; name?: string }
    | { kind: 'remove-ref'; name: string }
    | { kind: 'expire'; snapshots: Int64[] }
    | null
  const [dialog, setDialog] = useState<DialogState>(null)
  const commit = useTableCommit(cluster, wh, ns, table)
  const identifier = useMemo(() => ({ namespace: ns, name: table }), [ns, table])

  const key = qk.table(cluster, wh, ns, table)
  const q = useQuery({ queryKey: key, queryFn: () => loadTable(cluster, wh, ns, table) })
  const maint = useMaintenanceStatus(cluster, wh, ns, table)
  const header = (
    <PageHeader
      icon={<EntityBadgeIcon kind="table" />}
      title={<span className="font-mono">{table}</span>}
      subtitle={
        <span className="font-mono">
          {wh}.{namespaceLabel(ns)}.{table}
        </span>
      }
      badges={
        q.data && (
          <>
            <Badge tone="accent">Iceberg v{q.data.metadata['format-version']}</Badge>
            {(q.data.metadata['partition-specs'].find((s) => s['spec-id'] === q.data!.metadata['default-spec-id'])?.fields.length ?? 0) > 0 ? (
              <Badge>
                <Layers className="size-3" /> Partitioned
              </Badge>
            ) : (
              <Badge>Unpartitioned</Badge>
            )}
            <MaintenanceHealthBadge status={maint.data?.status} />
          </>
        )
      }
      actions={
        <>
          {q.data && <ViewPicker md={q.data.metadata} view={resolveView(q.data.metadata, at)} onChange={(v) => setAt(v)} />}
          <Tooltip content="Reload metadata">
            <Button size="icon" variant="outline" aria-label="Reload metadata" onClick={() => q.refetch()}>
              <RefreshCw className={cn(q.isFetching && 'animate-spin')} />
            </Button>
          </Tooltip>
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon" variant="outline" aria-label="Table actions">
                <Ellipsis />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>
                Rename or move…
              </MenuItem>
              {q.data && q.data.metadata['format-version'] < 3 && (
                <MenuItem icon={<ArrowUpCircle />} onSelect={() => setDialog({ kind: 'upgrade' })}>
                  Upgrade to Iceberg v{q.data.metadata['format-version'] + 1}…
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} danger onSelect={() => setDropping(true)}>
                Drop table…
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      }
    />
  )

  if (q.isError) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    )
  }
  if (q.isPending) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[74px]" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    )
  }

  const md = q.data.metadata
  const view = resolveView(md, at)
  const snap = view.snapshot
  const schema = currentSchema(md)!
  const names = fieldNames(schema)
  const spec = md['partition-specs'].find((s) => s['spec-id'] === md['default-spec-id'])
  const order = md['sort-orders']?.find((o) => o['order-id'] === md['default-sort-order-id'])
  const markers = {
    partition: new Map(spec?.fields.map((f) => [f['source-id'], transformLabel(f.transform, names.get(f['source-id']) ?? '')]) ?? []),
    sort: new Map(order?.fields.map((f) => [f['source-id'], `${f.direction}, ${f['null-order']}`]) ?? []),
  }

  const current = view.kind === 'current'

  return (
    <div className="flex flex-col gap-5">
      {header}
      {!current && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-warning/40 bg-warning-subtle px-3 py-2 text-[12.5px] text-warning">
          <Clock className="size-4 shrink-0" />
          <span>
            Viewing <span className="font-mono font-semibold">{view.label}</span>
            {snap && <> as of {formatDateTime(snap['timestamp-ms'])}</>}. Statistics, overview and schema show this snapshot; preview, properties and all edits apply to the current table.
          </span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAt('')}>
            Back to current
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Records" value={<span title={formatNumber(summaryNumber(snap, 'total-records'))}>{formatCompact(summaryNumber(snap, 'total-records') ?? (snap ? undefined : 0))}</span>} />
        <StatCard label="Data files" value={formatNumber(summaryNumber(snap, 'total-data-files') ?? (snap ? undefined : 0))} />
        <StatCard label="Size" value={formatBytes(summaryNumber(snap, 'total-files-size') ?? (snap ? undefined : 0))} />
        <StatCard label="Snapshots" value={formatNumber(md.snapshots?.length ?? 0)} />
        {current ? (
          <StatCard label="Last commit" value={<span className="text-[18px]">{formatRelative(md['last-updated-ms'])}</span>} hint={formatDateTime(md['last-updated-ms'])} />
        ) : (
          <StatCard label="Snapshot committed" value={<span className="text-[18px]">{formatRelative(snap?.['timestamp-ms'])}</span>} hint={formatDateTime(snap?.['timestamp-ms'])} />
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setAt(at, v)}>
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="overview" icon={<Info />}>Overview</TabsTrigger>
          <TabsTrigger value="preview" icon={<Rows3 />}>Preview</TabsTrigger>
          <TabsTrigger value="schema" icon={<ListTree />} count={(view.schema ?? schema).fields.length}>Schema</TabsTrigger>
          <TabsTrigger value="partitions" icon={<Layers />}>Partitioning</TabsTrigger>
          <TabsTrigger value="snapshots" icon={<GitCommitHorizontal />} count={md.snapshots?.length ?? 0}>Snapshots</TabsTrigger>
          <TabsTrigger value="maintenance" icon={<Wrench />}>Maintenance</TabsTrigger>
          <TabsTrigger value="properties" icon={<SlidersHorizontal />} count={Object.keys(md.properties ?? {}).length}>Properties</TabsTrigger>
          <TabsTrigger value="settings" icon={<Lock />}>Encryption & tags</TabsTrigger>
          <TabsTrigger value="metadata" icon={<FileJson />}>Metadata</TabsTrigger>
          <TabsTrigger value="access" icon={<KeyRound />}>Access</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab data={q.data} wh={wh} view={view} />
        </TabsContent>
        <TabsContent value="preview">
          {!current && <p className="mb-3 text-[12.5px] text-muted">Preview always reads the current snapshot of main.</p>}
          <PreviewTab cluster={cluster} wh={wh} ns={ns} table={table} currentSnapshot={md['current-snapshot-id'] != null ? String(md['current-snapshot-id']) : undefined} />
        </TabsContent>
        <TabsContent value="schema">
          <div className="mb-3 flex justify-end">
            <Button variant="outline" onClick={() => setDialog({ kind: 'schema' })}>
              <GitCompare /> Evolve schema
            </Button>
          </div>
          <SchemaTree schemas={md.schemas} currentId={md['current-schema-id']} initialId={view.schema?.['schema-id']} markers={markers} />
        </TabsContent>
        <TabsContent value="partitions">
          <PartitionsTab md={md} schema={schema} onEvolveSpec={() => setDialog({ kind: 'spec' })} onEvolveSort={() => setDialog({ kind: 'sort' })} />
        </TabsContent>
        <TabsContent value="snapshots">
          <SnapshotsTab
            md={md}
            actions={{
              onRollback: (snapshot) => setDialog({ kind: 'rollback', snapshot }),
              onCreateRef: (snapshot) => setDialog({ kind: 'ref', snapshot }),
              onEditRef: (name) => setDialog({ kind: 'ref', name }),
              onRemoveRef: (name) => setDialog({ kind: 'remove-ref', name }),
              onExpire: (snapshots) => setDialog({ kind: 'expire', snapshots }),
              onViewAt: (id) => setAt(`snap:${id}`, 'overview'),
            }}
          />
        </TabsContent>
        <TabsContent value="maintenance">
          <MaintenanceTab cluster={cluster} wh={wh} ns={ns} table={table} />
        </TabsContent>
        <TabsContent value="properties">
          <Card>
            <CardHeader title="Table properties" description="Committed atomically (set-properties / remove-properties), guarded by the table UUID." />
            <div className="p-4">
              <PropertiesEditor
                properties={md.properties ?? {}}
                onSave={(c) => commit.apply(propertiesChange(md, identifier, c.updates, c.removals))}
                onStage={(c) => commit.stage(propertiesChange(md, identifier, c.updates, c.removals))}
                saving={commit.pending}
              />
              {commit.error != null && !dialog && (
                <div className="mt-3">
                  <CommitBarErrorOnly commit={commit} />
                </div>
              )}
            </div>
          </Card>
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab cluster={cluster} wh={wh} ns={ns} table={table} />
        </TabsContent>
        <TabsContent value="metadata">
          <MetadataTab name={table} metadata={md} location={q.data['metadata-location']} log={md['metadata-log']} />
        </TabsContent>
        <TabsContent value="access">
          <AccessPanel warehouse={wh} resource={{ kind: 'table', uuid: md['table-uuid'] }} />
        </TabsContent>
      </Tabs>

      {(() => {
        const base = { md, id: identifier, commit, onOpenChange: (v: boolean) => !v && setDialog(null) }
        switch (dialog?.kind) {
          case 'schema':
            return <EvolveSchemaDialog {...base} open />
          case 'spec':
            return <EvolvePartitionDialog {...base} open />
          case 'sort':
            return <EvolveSortDialog {...base} open />
          case 'upgrade':
            return <UpgradeFormatDialog {...base} open />
          case 'rollback':
            return <RollbackDialog {...base} open snapshotId={dialog.snapshot} />
          case 'ref':
            return <RefDialog {...base} open snapshotId={dialog.snapshot} editName={dialog.name} />
          case 'remove-ref':
            return <RemoveRefDialog {...base} open name={dialog.name} />
          case 'expire':
            return <ExpireSnapshotsDialog {...base} open snapshotIds={dialog.snapshots} />
        }
        return null
      })()}
      <RenameDialog
        kind="table"
        cluster={cluster}
        wh={wh}
        ns={ns}
        name={table}
        open={renaming}
        onOpenChange={setRenaming}
        onRenamed={(nns, n) => navigate(paths.table(cluster, wh, nns, n), { replace: true })}
      />
      <DropTableDialog cluster={cluster} wh={wh} ns={ns} name={table} open={dropping} onOpenChange={setDropping} onDropped={() => navigate(`${paths.namespace(cluster, wh, ns)}?tab=tables`, { replace: true })} />
    </div>
  )
}

/** Shows the last commit error (e.g. a 409 conflict) outside of a dialog. */
function CommitBarErrorOnly({ commit }: { commit: ReturnType<typeof useTableCommit> }) {
  return <CommitBar commit={commit} build={() => null} errorsOnly />
}
