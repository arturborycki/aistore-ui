import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Ellipsis, Search, Trash2, Warehouse as WarehouseIcon } from 'lucide-react'
import { DataTable, Pagination, type Column } from '@/components/ui/data-table'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/layout'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown'
import { Button } from '@/components/ui/button'
import { listWarehouses, type EntryStats } from '@/lib/catalog'
import { formatBytes, formatCompact, formatNumber } from '@/lib/format'
import { qk } from '@/lib/queryKeys'
import { useStatsList } from '@/lib/useStatsList'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { CreateWarehouseDialog, DeleteWarehouseDialog } from './WarehouseDialogs'

interface Row {
  name: string
  stats?: EntryStats
}

export function WarehousesPage() {
  const cluster = useCluster()
  const navigate = useNavigate()
  const [toDelete, setToDelete] = useState<string | null>(null)
  const list = useStatsList(qk.warehouses(cluster), (p) => listWarehouses(cluster, p), 50)
  const data = list.query.data
  const rows: Row[] = (data?.items ?? []).map((name) => ({ name, stats: data?.stats[name] }))

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Name',
      sortKey: 'name',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <EntityIcon kind="warehouse" />
          <span className="font-mono text-[12.5px] font-medium">{r.name}</span>
        </span>
      ),
    },
    { key: 'namespaces', header: 'Namespaces', sortKey: 'namespaces', align: 'right', cell: (r) => formatNumber(r.stats?.namespaces) },
    { key: 'tables', header: 'Tables', sortKey: 'tables', align: 'right', cell: (r) => formatNumber(r.stats?.tables) },
    { key: 'records', header: 'Records', sortKey: 'records', align: 'right', cell: (r) => <span title={formatNumber(r.stats?.records)}>{formatCompact(r.stats?.records)}</span> },
    { key: 'size', header: 'Size', sortKey: 'size', align: 'right', cell: (r) => formatBytes(r.stats?.size) },
  ]

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Warehouses" subtitle="Warehouses you are allowed to see on this cluster." actions={<CreateWarehouseDialog cluster={cluster} />} />
      <div className="flex items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <Input value={list.search} onChange={(e) => list.setSearch(e.target.value)} placeholder="Search warehouses" aria-label="Search warehouses" className="pl-8" />
        </div>
        {list.query.isFetching && !list.query.isPending && <span className="text-[12px] text-subtle">Updating…</span>}
      </div>
      {list.query.isError ? (
        <ErrorState error={list.query.error} onRetry={() => list.query.refetch()} />
      ) : (
        <div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.name}
            loading={list.query.isPending}
            sort={list.sort}
            onSort={list.setSort}
            onRowClick={(r) => navigate(paths.warehouse(cluster, r.name))}
            rowActions={(r) => (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${r.name}`} className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100">
                    <Ellipsis />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<WarehouseIcon />} onSelect={() => navigate(paths.warehouse(cluster, r.name))}>
                    Open
                  </MenuItem>
                  <MenuItem icon={<Trash2 />} danger onSelect={() => setToDelete(r.name)}>
                    Delete…
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
            empty={
              <EmptyState icon={<WarehouseIcon />} title={list.search ? 'No matching warehouses' : 'No warehouses yet'} className="m-3 border-0">
                {list.search ? 'Try a different search.' : 'Create a warehouse to start organising Iceberg tables, or ask an administrator for access to an existing one.'}
              </EmptyState>
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={data?.total ?? null} count={rows.length} onPage={list.setPage} />
        </div>
      )}
      {toDelete && <DeleteWarehouseDialog cluster={cluster} warehouse={toDelete} open onOpenChange={(v) => !v && setToDelete(null)} />}
    </div>
  )
}
