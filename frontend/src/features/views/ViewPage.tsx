import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Code, Ellipsis, FileJson, History, Info, KeyRound, ListTree, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyButton, CopyText } from '@/components/ui/copy-button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown'
import { EntityBadgeIcon } from '@/components/ui/entity-icon'
import { Card, CardHeader, KeyValue, PageHeader } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { SqlView } from '@/components/ui/sql-view'
import { ErrorState } from '@/components/ui/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { loadView, resourceArn } from '@/lib/catalog'
import { cn } from '@/lib/cn'
import { diffLines } from '@/lib/diff'
import { formatDateTime, formatRelative } from '@/lib/format'
import { currentViewVersion, type ViewMetadata, type ViewVersion } from '@/lib/iceberg'
import { decodeNamespaceParam, namespaceLabel } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { AccessPanel } from '@/features/warehouses/AccessPanel'
import { DropViewDialog, RenameDialog } from '@/features/tables/EntityDialogs'
import { MetadataTab } from '@/features/tables/MetadataTab'
import { SchemaTree } from '@/features/tables/SchemaTree'

function DialectSql({ version }: { version: ViewVersion }) {
  const reps = version.representations.filter((r) => r.type === 'sql')
  const [dialect, setDialect] = useState(reps[0]?.dialect)
  const rep = reps.find((r) => r.dialect === dialect) ?? reps[0]
  if (!rep) return <p className="p-4 text-[12.5px] text-subtle">This version has no SQL representation.</p>
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex gap-0.5 rounded-[var(--radius-control)] bg-surface p-0.5 text-[12px]" role="tablist" aria-label="SQL dialect">
          {reps.map((r) => (
            <button key={r.dialect} role="tab" aria-selected={r.dialect === rep.dialect} onClick={() => setDialect(r.dialect)} className={cn('h-6 rounded-[4px] px-2.5 font-mono text-muted', r.dialect === rep.dialect && 'bg-bg font-medium text-fg shadow-sm')}>
              {r.dialect}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <CopyButton value={rep.sql} label="Copy SQL" />
      </div>
      <SqlView sql={rep.sql} />
    </div>
  )
}

function VersionsTab({ md }: { md: ViewMetadata }) {
  const versions = [...md.versions].sort((a, b) => b['version-id'] - a['version-id'])
  const [selected, setSelected] = useState(md['current-version-id'])
  const v = versions.find((x) => x['version-id'] === selected) ?? versions[0]
  const prev = versions.find((x) => x['version-id'] < v['version-id'])
  const sqlOf = (x?: ViewVersion) => x?.representations.find((r) => r.type === 'sql')?.sql ?? ''
  const diff = useMemo(() => (prev ? diffLines(sqlOf(prev), sqlOf(v)) : []), [prev, v])
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Versions" />
        <ol>
          {versions.map((x) => (
            <li key={x['version-id']}>
              <button
                type="button"
                onClick={() => setSelected(x['version-id'])}
                className={cn('flex w-full flex-col items-start gap-0.5 border-b border-border px-4 py-2.5 text-left last:border-0 hover:bg-bg-subtle', x['version-id'] === v['version-id'] && 'bg-accent-subtle/50')}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px] font-medium">v{x['version-id']}</span>
                  {x['version-id'] === md['current-version-id'] && <Badge tone="accent">current</Badge>}
                </span>
                <span className="text-[12px] text-muted">
                  {formatRelative(x['timestamp-ms'])}
                  {x.summary?.['engine-name'] && ` · ${x.summary['engine-name']} ${x.summary['engine-version'] ?? ''}`}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </Card>
      <Card>
        <CardHeader title={prev ? `Changes from v${prev['version-id']} to v${v['version-id']}` : `Version ${v['version-id']} (initial)`} description={formatDateTime(v['timestamp-ms'])} />
        {prev ? (
          <pre className="overflow-auto py-2 font-mono text-[12.5px] leading-6">
            {diff.map((d, i) => (
              <div key={i} className={cn('flex', d.kind === 'add' && 'bg-success-subtle', d.kind === 'del' && 'bg-danger-subtle')}>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-subtle">{d.a ?? ''}</span>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-subtle">{d.b ?? ''}</span>
                <span className={cn('w-5 shrink-0 select-none text-center', d.kind === 'add' ? 'text-success' : d.kind === 'del' ? 'text-danger' : 'text-subtle')}>
                  {d.kind === 'add' ? '+' : d.kind === 'del' ? '−' : ' '}
                </span>
                <code className="whitespace-pre pr-4">{d.text}</code>
              </div>
            ))}
          </pre>
        ) : (
          <SqlView sql={sqlOf(v)} />
        )}
      </Card>
    </div>
  )
}

export function ViewPage() {
  const cluster = useCluster()
  const params = useParams()
  const wh = params.wh!
  const ns = useMemo(() => decodeNamespaceParam(params.ns), [params.ns])
  const view = params.view!
  const [search, setSearch] = useSearchParams()
  const tab = search.get('tab') ?? 'definition'
  const navigate = useNavigate()
  const [renaming, setRenaming] = useState(false)
  const [dropping, setDropping] = useState(false)
  const q = useQuery({ queryKey: qk.view(cluster, wh, ns, view), queryFn: () => loadView(cluster, wh, ns, view) })

  const header = (
    <PageHeader
      icon={<EntityBadgeIcon kind="view" />}
      title={<span className="font-mono">{view}</span>}
      subtitle={<span className="font-mono">{wh}.{namespaceLabel(ns)}.{view}</span>}
      badges={q.data && <><Badge tone="info">View</Badge><Badge>v{q.data.metadata['current-version-id']}</Badge></>}
      actions={
        <Menu>
          <MenuTrigger asChild>
            <Button size="icon" variant="outline" aria-label="View actions">
              <Ellipsis />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>Rename or move…</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onSelect={() => setDropping(true)}>Drop view…</MenuItem>
          </MenuContent>
        </Menu>
      }
    />
  )
  if (q.isError) return <div className="flex flex-col gap-5">{header}<ErrorState error={q.error} onRetry={() => q.refetch()} /></div>
  if (q.isPending) return <div className="flex flex-col gap-5">{header}<Skeleton className="h-80" /></div>

  const md = q.data.metadata
  const cur = currentViewVersion(md)
  const schemaId = cur?.['schema-id'] ?? md.schemas[md.schemas.length - 1]?.['schema-id']

  return (
    <div className="flex flex-col gap-5">
      {header}
      <Tabs value={tab} onValueChange={(v) => setSearch({ tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="definition" icon={<Code />}>Definition</TabsTrigger>
          <TabsTrigger value="versions" icon={<History />} count={md.versions.length}>Versions</TabsTrigger>
          <TabsTrigger value="schema" icon={<ListTree />}>Schema</TabsTrigger>
          <TabsTrigger value="details" icon={<Info />}>Details</TabsTrigger>
          <TabsTrigger value="metadata" icon={<FileJson />}>Metadata</TabsTrigger>
          <TabsTrigger value="access" icon={<KeyRound />}>Access</TabsTrigger>
        </TabsList>
        <TabsContent value="definition">
          <Card>
            <CardHeader title="SQL definition" description={cur ? `Version ${cur['version-id']} · ${formatDateTime(cur['timestamp-ms'])}` : undefined} />
            {cur ? <DialectSql version={cur} /> : <p className="p-4 text-subtle">No current version.</p>}
          </Card>
        </TabsContent>
        <TabsContent value="versions">
          <VersionsTab md={md} />
        </TabsContent>
        <TabsContent value="schema">
          <SchemaTree schemas={md.schemas} currentId={schemaId} />
        </TabsContent>
        <TabsContent value="details">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="View" />
              <div className="p-4">
                <KeyValue
                  items={[
                    { label: 'UUID', value: <CopyText value={md['view-uuid']} /> },
                    { label: 'ARN', value: <CopyText value={resourceArn.view(wh, md['view-uuid'])} /> },
                    { label: 'Location', value: <CopyText value={md.location} /> },
                    { label: 'Format version', value: `v${md['format-version']}` },
                    { label: 'Default namespace', value: <span className="font-mono text-[12px]">{cur?.['default-namespace']?.join('.') ?? '—'}</span> },
                    { label: 'Engine', value: cur?.summary?.['engine-name'] ? `${cur.summary['engine-name']} ${cur.summary['engine-version'] ?? ''}` : '—' },
                  ]}
                />
              </div>
            </Card>
            <Card>
              <CardHeader title={<span className="flex items-center gap-2"><SlidersHorizontal className="size-4 text-muted" />Properties</span>} />
              <div className="p-4">
                {Object.keys(md.properties ?? {}).length === 0 ? (
                  <p className="text-[12.5px] text-subtle">No properties</p>
                ) : (
                  <KeyValue items={Object.entries(md.properties ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ label: k, value: <CopyText value={v} /> }))} />
                )}
              </div>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="metadata">
          <MetadataTab name={view} metadata={md} location={q.data['metadata-location']} />
        </TabsContent>
        <TabsContent value="access">
          <AccessPanel warehouse={wh} resource={{ kind: 'view', uuid: md['view-uuid'] }} />
        </TabsContent>
      </Tabs>
      <RenameDialog kind="view" cluster={cluster} wh={wh} ns={ns} name={view} open={renaming} onOpenChange={setRenaming} onRenamed={(nns, n) => navigate(paths.view(cluster, wh, nns, n), { replace: true })} />
      <DropViewDialog cluster={cluster} wh={wh} ns={ns} name={view} open={dropping} onOpenChange={setDropping} onDropped={() => navigate(`${paths.namespace(cluster, wh, ns)}?tab=views`, { replace: true })} />
    </div>
  )
}
