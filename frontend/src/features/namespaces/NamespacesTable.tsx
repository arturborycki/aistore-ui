import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Ellipsis, FolderOpen, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable, Pagination, type Column } from '@/components/ui/data-table'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Input } from '@/components/ui/input'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { listNamespaces, namespaceStats, type EntryStats } from '@/lib/catalog'
import { formatBytes, formatCompact, formatNumber } from '@/lib/format'
import type { Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { useStatsList } from '@/lib/useStatsList'
import { paths } from '@/layout/paths'
import { CreateNamespaceDialog, DeleteNamespaceDialog } from './NamespaceDialogs'

interface Row {
  ns: Namespace
  stats?: EntryStats
}

export function NamespacesTable({ cluster, warehouse, parent }: { cluster: string; warehouse: string; parent: Namespace }) {
  const navigate = useNavigate()
  const [toDelete, setToDelete] = useState<Namespace | null>(null)
  const list = useStatsList(qk.namespaces(cluster, warehouse, parent), (p) => listNamespaces(cluster, warehouse, { ...p, parent }), 50)
  const data = list.query.data
  const rows: Row[] = (data?.items ?? []).map((ns) => ({ ns, stats: data ? namespaceStats(data.stats, ns) : undefined }))

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Name',
      sortKey: 'name',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <EntityIcon kind="namespace" />
          <span className="font-mono text-[12.5px] font-medium">{r.ns[r.ns.length - 1]}</span>
        </span>
      ),
    },
    { key: 'tables', header: 'Tables', sortKey: 'tables', align: 'right', cell: (r) => formatNumber(r.stats?.tables) },
    { key: 'records', header: 'Records', sortKey: 'records', align: 'right', cell: (r) => <span title={formatNumber(r.stats?.records)}>{formatCompact(r.stats?.records)}</span> },
    { key: 'size', header: 'Size', sortKey: 'size', align: 'right', cell: (r) => formatBytes(r.stats?.size) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <Input value={list.search} onChange={(e) => list.setSearch(e.target.value)} placeholder="Search namespaces" aria-label="Search namespaces" className="pl-8" />
        </div>
        <div className="flex-1" />
        <CreateNamespaceDialog cluster={cluster} warehouse={warehouse} parent={parent} trigger="small" />
      </div>
      {list.query.isError ? (
        <ErrorState error={list.query.error} onRetry={() => list.query.refetch()} />
      ) : (
        <div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.ns.join('\u001f')}
            loading={list.query.isPending}
            sort={list.sort}
            onSort={list.setSort}
            onRowClick={(r) => navigate(paths.namespace(cluster, warehouse, r.ns))}
            rowActions={(r) => (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${r.ns.join('.')}`} className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100">
                    <Ellipsis />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<FolderOpen />} onSelect={() => navigate(paths.namespace(cluster, warehouse, r.ns))}>
                    Open
                  </MenuItem>
                  <MenuItem icon={<Trash2 />} danger onSelect={() => setToDelete(r.ns)}>
                    Delete…
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
            empty={
              <EmptyState icon={<FolderOpen />} title={list.search ? 'No matching namespaces' : parent.length ? 'No child namespaces' : 'No namespaces yet'} className="m-3 border-0">
                {list.search ? 'Try a different search.' : 'Namespaces group tables and views. Create one to get started.'}
              </EmptyState>
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={data?.total ?? null} count={rows.length} onPage={list.setPage} />
        </div>
      )}
      {toDelete && <DeleteNamespaceDialog cluster={cluster} warehouse={warehouse} ns={toDelete} open onOpenChange={(v) => !v && setToDelete(null)} />}
    </div>
  )
}
