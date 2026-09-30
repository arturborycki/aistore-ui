import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import {
  ArrowUpCircle,
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
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown'
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
import { currentSchema, currentSnapshot, fieldNames, summaryNumber, transformLabel, type LoadTableResult } from '@/lib/iceberg'
import { decodeNamespaceParam, namespaceLabel } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { AccessPanel } from '@/features/warehouses/AccessPanel'
import { PropertiesEditor } from '@/features/namespaces/PropertiesEditor'
import { CommitBar, useTableCommit } from './CommitBar'
import { DropTableDialog, RenameDialog } from './EntityDialogs'
import { EvolvePartitionDialog, EvolveSchemaDialog, EvolveSortDialog, RefDialog, RemoveRefDialog, RollbackDialog, UpgradeFormatDialog } from './EvolveDialogs'
import { MaintenanceHealthBadge, MaintenanceTab, useMaintenanceStatus } from './MaintenanceTab'
import { MetadataTab } from './MetadataTab'
import { PartitionsTab } from './PartitionsTab'
import { PreviewTab } from './PreviewTab'
import { SchemaTree } from './SchemaTree'
import { SettingsTab } from './SettingsTab'
import { SnapshotsTab } from './SnapshotsTab'

function OverviewTab({ data, wh }: { data: LoadTableResult; wh: string }) {
  const md = data.metadata
  const snap = currentSnapshot(md)
  const schema = currentSchema(md)
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
        <CardHeader title="Current snapshot" />
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

export function TablePage() {
  const cluster = useCluster()
  const params = useParams()
  const wh = params.wh!
  const ns = useMemo(() => decodeNamespaceParam(params.ns), [params.ns])
  const table = params.table!
  const [search, setSearch] = useSearchParams()
  const tab = search.get('tab') ?? 'overview'
  const navigate = useNavigate()
  const [renaming, setRenaming] = useState(false)
  const [dropping, setDropping] = useState(false)
  type DialogState =
    | { kind: 'schema' | 'spec' | 'sort' | 'upgrade' }
    | { kind: 'rollback'; snapshot: Int64 }
    | { kind: 'ref'; snapshot?: Int64; name?: string }
    | { kind: 'remove-ref'; name: string }
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
  const snap = currentSnapshot(md)
  const schema = currentSchema(md)!
  const names = fieldNames(schema)
  const spec = md['partition-specs'].find((s) => s['spec-id'] === md['default-spec-id'])
  const order = md['sort-orders']?.find((o) => o['order-id'] === md['default-sort-order-id'])
  const markers = {
    partition: new Map(spec?.fields.map((f) => [f['source-id'], transformLabel(f.transform, names.get(f['source-id']) ?? '')]) ?? []),
    sort: new Map(order?.fields.map((f) => [f['source-id'], `${f.direction}, ${f['null-order']}`]) ?? []),
  }

  return (
    <div className="flex flex-col gap-5">
      {header}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Records" value={<span title={formatNumber(summaryNumber(snap, 'total-records'))}>{formatCompact(summaryNumber(snap, 'total-records') ?? (snap ? undefined : 0))}</span>} />
        <StatCard label="Data files" value={formatNumber(summaryNumber(snap, 'total-data-files') ?? (snap ? undefined : 0))} />
        <StatCard label="Size" value={formatBytes(summaryNumber(snap, 'total-files-size') ?? (snap ? undefined : 0))} />
        <StatCard label="Snapshots" value={formatNumber(md.snapshots?.length ?? 0)} />
        <StatCard label="Last commit" value={<span className="text-[18px]">{formatRelative(md['last-updated-ms'])}</span>} hint={formatDateTime(md['last-updated-ms'])} />
      </div>

      <Tabs value={tab} onValueChange={(v) => setSearch({ tab: v }, { replace: true })}>
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="overview" icon={<Info />}>Overview</TabsTrigger>
          <TabsTrigger value="preview" icon={<Rows3 />}>Preview</TabsTrigger>
          <TabsTrigger value="schema" icon={<ListTree />} count={schema.fields.length}>Schema</TabsTrigger>
          <TabsTrigger value="partitions" icon={<Layers />}>Partitioning</TabsTrigger>
          <TabsTrigger value="snapshots" icon={<GitCommitHorizontal />} count={md.snapshots?.length ?? 0}>Snapshots</TabsTrigger>
          <TabsTrigger value="maintenance" icon={<Wrench />}>Maintenance</TabsTrigger>
          <TabsTrigger value="properties" icon={<SlidersHorizontal />} count={Object.keys(md.properties ?? {}).length}>Properties</TabsTrigger>
          <TabsTrigger value="settings" icon={<Lock />}>Encryption & tags</TabsTrigger>
          <TabsTrigger value="metadata" icon={<FileJson />}>Metadata</TabsTrigger>
          <TabsTrigger value="access" icon={<KeyRound />}>Access</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab data={q.data} wh={wh} />
        </TabsContent>
        <TabsContent value="preview">
          <PreviewTab cluster={cluster} wh={wh} ns={ns} table={table} currentSnapshot={snap ? String(snap['snapshot-id']) : undefined} />
        </TabsContent>
        <TabsContent value="schema">
          <div className="mb-3 flex justify-end">
            <Button variant="outline" onClick={() => setDialog({ kind: 'schema' })}>
              <GitCompare /> Evolve schema
            </Button>
          </div>
          <SchemaTree schemas={md.schemas} currentId={md['current-schema-id']} markers={markers} />
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
