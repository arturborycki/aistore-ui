import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Ellipsis, FolderTree, Info, KeyRound, Settings2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyText } from '@/components/ui/copy-button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown'
import { EntityBadgeIcon } from '@/components/ui/entity-icon'
import { Card, CardHeader, KeyValue, PageHeader, StatCard } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  arn,
  deleteWarehouseEncryption,
  getWarehouse,
  getWarehouseConfig,
  isSystemWarehouse,
  getWarehouseEncryption,
  getWarehouseMaintenance,
  getWarehouseTags,
  listWarehouses,
  putWarehouseEncryption,
  putWarehouseMaintenance,
  tagWarehouse,
  untagWarehouse,
} from '@/lib/catalog'
import { EncryptionCard, MaintenanceSettings, TagsCard } from '@/features/settings/SettingsEditors'
import { formatBytes, formatCompact, formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { qk } from '@/lib/queryKeys'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { NamespacesTable } from '@/features/namespaces/NamespacesTable'
import { AccessPanel } from './AccessPanel'
import { DeleteWarehouseDialog } from './WarehouseDialogs'

export function WarehousePage() {
  const cluster = useCluster()
  const wh = useParams().wh!
  const [search, setSearch] = useSearchParams()
  const tab = search.get('tab') ?? 'namespaces'
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)

  const q = useQuery({ queryKey: qk.warehouse(cluster, wh), queryFn: () => getWarehouse(cluster, wh) })
  // Aggregate statistics come from the statistics-mode listing, filtered to this warehouse.
  const stats = useQuery({
    queryKey: [...qk.warehouse(cluster, wh), 'stats'],
    queryFn: async () => (await listWarehouses(cluster, { search: wh, pageSize: 100 })).stats[wh] ?? null,
  })

  if (q.isError) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader icon={<EntityBadgeIcon kind="warehouse" />} title={<span className="font-mono">{wh}</span>} />
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    )
  }

  const w = q.data
  const props = w?.properties ?? {}
  const s = stats.data
  const system = isSystemWarehouse(w)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<EntityBadgeIcon kind="warehouse" />}
        title={<span className="font-mono">{wh}</span>}
        subtitle={
          q.isPending ? (
            <Skeleton className="h-3.5 w-48" />
          ) : (
            <>
              {system && <span>Reserved AIStor system warehouse. It is read-only; its namespaces mirror your buckets.</span>}
              {w?.['created-at'] && !system && <span title={formatDateTime(w['created-at'])}>Created {formatRelative(w['created-at'])}</span>}
              {props.description && <span> · {props.description}</span>}
            </>
          )
        }
        badges={
          <>
            <Badge tone="accent">Warehouse</Badge>
            {system && <Badge tone="warning">System · read-only</Badge>}
            {w?.bucket && w.bucket !== wh && <Badge mono>bucket: {w.bucket}</Badge>}
          </>
        }
        actions={
          !system && (
            <Menu>
            <MenuTrigger asChild>
              <Button size="icon" variant="outline" aria-label="Warehouse actions">
                <Ellipsis />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<Trash2 />} danger onSelect={() => setDeleting(true)}>
                Delete warehouse…
              </MenuItem>
            </MenuContent>
            </Menu>
          )
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Namespaces" value={formatNumber(s?.namespaces)} loading={stats.isPending} />
        <StatCard label="Tables" value={formatNumber(s?.tables)} loading={stats.isPending} />
        <StatCard label="Records" value={<span title={formatNumber(s?.records)}>{formatCompact(s?.records)}</span>} loading={stats.isPending} />
        <StatCard label="Size" value={formatBytes(s?.size)} loading={stats.isPending} />
      </div>

      <Tabs value={tab} onValueChange={(v) => setSearch({ tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="namespaces" icon={<FolderTree />}>
            Namespaces
          </TabsTrigger>
          <TabsTrigger value="details" icon={<Info />}>
            Details
          </TabsTrigger>
          {!system && (
            <TabsTrigger value="settings" icon={<Settings2 />}>
              Settings
            </TabsTrigger>
          )}
          <TabsTrigger value="access" icon={<KeyRound />}>
            Access
          </TabsTrigger>
        </TabsList>
        <TabsContent value="namespaces">
          <NamespacesTable cluster={cluster} warehouse={wh} parent={[]} readOnly={system} />
        </TabsContent>
        <TabsContent value="details">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Warehouse" />
              <div className="p-4">
                {q.isPending ? (
                  <Skeleton className="h-28 w-full" />
                ) : (
                  <KeyValue
                    items={[
                      { label: 'Name', value: <CopyText value={wh} /> },
                      { label: 'Bucket', value: w?.bucket ? <CopyText value={w.bucket} /> : '—' },
                      { label: 'UUID', value: w?.uuid ? <CopyText value={w.uuid} /> : '—' },
                      { label: 'Created', value: formatDateTime(w?.['created-at']) },
                      { label: 'ARN', value: <CopyText value={arn.warehouse(wh)} /> },
                    ]}
                  />
                )}
              </div>
            </Card>
            <Card>
              <CardHeader title="Properties" description="Set by AIStor when the warehouse was created." />
              <div className="p-4">
                {q.isPending ? (
                  <Skeleton className="h-28 w-full" />
                ) : Object.keys(props).length === 0 ? (
                  <p className="text-[12.5px] text-subtle">No properties</p>
                ) : (
                  <KeyValue items={Object.entries(props).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ label: k, value: <CopyText value={v} /> }))} />
                )}
              </div>
            </Card>
            <CatalogConfigCard cluster={cluster} wh={wh} />
          </div>
        </TabsContent>
        <TabsContent value="settings">
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 lg:grid-cols-2">
              <EncryptionCard
                scope="warehouse"
                queryKey={[...qk.warehouse(cluster, wh), 'encryption']}
                load={() => getWarehouseEncryption(cluster, wh)}
                save={(c) => putWarehouseEncryption(cluster, wh, c)}
                onRemove={() => deleteWarehouseEncryption(cluster, wh)}
              />
              <TagsCard
                queryKey={[...qk.warehouse(cluster, wh), 'tags']}
                description="Tags on the warehouse (table bucket)."
                load={() => getWarehouseTags(cluster, wh)}
                add={(t) => tagWarehouse(cluster, wh, t)}
                remove={(k) => untagWarehouse(cluster, wh, k)}
              />
            </div>
            <section className="flex flex-col gap-2">
              <h3 className="text-[12px] font-medium uppercase tracking-wide text-subtle">Maintenance defaults for all tables</h3>
              <MaintenanceSettings
                queryKey={[...qk.warehouse(cluster, wh), 'maintenance']}
                types={['icebergUnreferencedFileRemoval', 'icebergSnapshotManagement', 'icebergCompaction']}
                load={() => getWarehouseMaintenance(cluster, wh)}
                save={(t, v) => putWarehouseMaintenance(cluster, wh, t, v)}
              />
            </section>
          </div>
        </TabsContent>
        <TabsContent value="access">
          <AccessPanel warehouse={wh} />
        </TabsContent>
      </Tabs>

      <DeleteWarehouseDialog cluster={cluster} warehouse={wh} open={deleting} onOpenChange={setDeleting} onDeleted={() => navigate(paths.warehouses(cluster), { replace: true })} />
    </div>
  )
}

/** The Iceberg REST /config of the warehouse, as engines receive it. */
function CatalogConfigCard({ cluster, wh }: { cluster: string; wh: string }) {
  const q = useQuery({ queryKey: [...qk.warehouse(cluster, wh), 'config'], queryFn: () => getWarehouseConfig(cluster, wh), staleTime: 300_000 })
  const kv = (m?: Record<string, string>) => Object.entries(m ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Catalog configuration" description="What Iceberg clients receive from GET /v1/config?warehouse=… : defaults, overrides and the REST endpoints this server supports." />
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {q.isPending ? (
          <Skeleton className="h-28 w-full lg:col-span-2" />
        ) : q.isError ? (
          <div className="lg:col-span-2">
            <ErrorState error={q.error} compact />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {(['defaults', 'overrides'] as const).map((k) => (
                <div key={k}>
                  <h3 className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-subtle">{k}</h3>
                  {kv(q.data[k]).length === 0 ? (
                    <p className="text-[12.5px] text-subtle">None</p>
                  ) : (
                    <KeyValue items={kv(q.data[k]).map(([a, b]) => ({ label: a, value: <span className="break-all font-mono text-[12px]">{b}</span> }))} />
                  )}
                </div>
              ))}
            </div>
            <div>
              <h3 className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-subtle">Endpoints ({q.data.endpoints?.length ?? 0})</h3>
              <ul className="grid max-h-64 gap-x-4 overflow-y-auto font-mono text-[11.5px] sm:grid-cols-2" aria-label="Supported endpoints">
                {(q.data.endpoints ?? []).map((e) => {
                  const [m, ...rest] = e.split(' ')
                  return (
                    <li key={e} className="truncate py-0.5" title={e}>
                      <span className="inline-block w-14 text-subtle">{m}</span>
                      {rest.join(' ').replace('/v1/{prefix}', '')}
                    </li>
                  )
                })}
              </ul>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
