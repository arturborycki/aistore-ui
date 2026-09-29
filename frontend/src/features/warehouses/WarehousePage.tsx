import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Ellipsis, FolderTree, Info, KeyRound, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyText } from '@/components/ui/copy-button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown'
import { EntityBadgeIcon } from '@/components/ui/entity-icon'
import { Card, CardHeader, KeyValue, PageHeader, StatCard } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { arn, getWarehouse, listWarehouses } from '@/lib/catalog'
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
              {w?.['created-at'] && <span title={formatDateTime(w['created-at'])}>Created {formatRelative(w['created-at'])}</span>}
              {props.description && <span> · {props.description}</span>}
            </>
          )
        }
        badges={
          <>
            <Badge tone="accent">Warehouse</Badge>
            {w?.bucket && w.bucket !== wh && <Badge mono>bucket: {w.bucket}</Badge>}
          </>
        }
        actions={
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
          <TabsTrigger value="access" icon={<KeyRound />}>
            Access
          </TabsTrigger>
        </TabsList>
        <TabsContent value="namespaces">
          <NamespacesTable cluster={cluster} warehouse={wh} parent={[]} />
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
