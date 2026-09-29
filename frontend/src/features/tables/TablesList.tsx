import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Ellipsis, Eye, Pencil, Search, Table2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable, Pagination, type Column } from '@/components/ui/data-table'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Input } from '@/components/ui/input'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { listAllViews, listTables, type EntryStats } from '@/lib/catalog'
import { formatBytes, formatCompact, formatNumber } from '@/lib/format'
import type { TableIdentifier } from '@/lib/iceberg'
import type { Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { useStatsList } from '@/lib/useStatsList'
import { paths } from '@/layout/paths'
import { DropTableDialog, DropViewDialog, RenameDialog } from './EntityDialogs'

interface Row {
  id: TableIdentifier
  stats?: EntryStats
}

type Pending = { kind: 'rename-table' | 'drop-table' | 'rename-view' | 'drop-view'; name: string } | null

function RowMenu({ name, onOpen, onRename, onDrop }: { name: string; onOpen: () => void; onRename: () => void; onDrop: () => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${name}`} className="opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100">
          <Ellipsis />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={<Eye />} onSelect={onOpen}>Open</MenuItem>
        <MenuItem icon={<Pencil />} onSelect={onRename}>Rename or move…</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} danger onSelect={onDrop}>Drop…</MenuItem>
      </MenuContent>
    </Menu>
  )
}

export function TablesList({ cluster, wh, ns }: { cluster: string; wh: string; ns: Namespace }) {
  const navigate = useNavigate()
  const [pending, setPending] = useState<Pending>(null)
  const list = useStatsList(qk.tables(cluster, wh, ns), (p) => listTables(cluster, wh, ns, p), 50)
  const data = list.query.data
  const rows: Row[] = (data?.items ?? []).map((id) => ({ id, stats: data?.stats[id.name] }))
  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Name',
      sortKey: 'name',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <EntityIcon kind="table" />
          <span className="font-mono text-[12.5px] font-medium">{r.id.name}</span>
        </span>
      ),
    },
    { key: 'records', header: 'Records', sortKey: 'records', align: 'right', cell: (r) => <span title={formatNumber(r.stats?.records)}>{formatCompact(r.stats?.records)}</span> },
    { key: 'size', header: 'Size', sortKey: 'size', align: 'right', cell: (r) => formatBytes(r.stats?.size) },
  ]
  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-72">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
        <Input value={list.search} onChange={(e) => list.setSearch(e.target.value)} placeholder="Search tables" aria-label="Search tables" className="pl-8" />
      </div>
      {list.query.isError ? (
        <ErrorState error={list.query.error} onRetry={() => list.query.refetch()} />
      ) : (
        <div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id.name}
            loading={list.query.isPending}
            sort={list.sort}
            onSort={list.setSort}
            onRowClick={(r) => navigate(paths.table(cluster, wh, ns, r.id.name))}
            rowActions={(r) => (
              <RowMenu
                name={r.id.name}
                onOpen={() => navigate(paths.table(cluster, wh, ns, r.id.name))}
                onRename={() => setPending({ kind: 'rename-table', name: r.id.name })}
                onDrop={() => setPending({ kind: 'drop-table', name: r.id.name })}
              />
            )}
            empty={
              <EmptyState icon={<Table2 />} title={list.search ? 'No matching tables' : 'No tables in this namespace'} className="m-3 border-0">
                {list.search ? 'Try a different search.' : (
                  <>
                    Create tables with any Iceberg engine pointed at <span className="font-mono">/_iceberg</span> with warehouse <span className="font-mono">{wh}</span>, for example Spark, Trino or PyIceberg.
                  </>
                )}
              </EmptyState>
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={data?.total ?? null} count={rows.length} onPage={list.setPage} />
        </div>
      )}
      {pending?.kind === 'rename-table' && (
        <RenameDialog kind="table" cluster={cluster} wh={wh} ns={ns} name={pending.name} open onOpenChange={(v) => !v && setPending(null)} onRenamed={(nns, n) => navigate(paths.table(cluster, wh, nns, n))} />
      )}
      {pending?.kind === 'drop-table' && <DropTableDialog cluster={cluster} wh={wh} ns={ns} name={pending.name} open onOpenChange={(v) => !v && setPending(null)} />}
    </div>
  )
}

export function ViewsList({ cluster, wh, ns }: { cluster: string; wh: string; ns: Namespace }) {
  const navigate = useNavigate()
  const [pending, setPending] = useState<Pending>(null)
  const [filter, setFilter] = useState('')
  const q = useQuery({ queryKey: qk.views(cluster, wh, ns), queryFn: () => listAllViews(cluster, wh, ns) })
  const rows = (q.data ?? []).filter((v) => !filter || v.name.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-72">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter views" aria-label="Filter views" className="pl-8" />
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (r: TableIdentifier) => (
                <span className="flex items-center gap-2">
                  <EntityIcon kind="view" />
                  <span className="font-mono text-[12.5px] font-medium">{r.name}</span>
                </span>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.name}
          loading={q.isPending}
          onRowClick={(r) => navigate(paths.view(cluster, wh, ns, r.name))}
          rowActions={(r) => (
            <RowMenu
              name={r.name}
              onOpen={() => navigate(paths.view(cluster, wh, ns, r.name))}
              onRename={() => setPending({ kind: 'rename-view', name: r.name })}
              onDrop={() => setPending({ kind: 'drop-view', name: r.name })}
            />
          )}
          empty={
            <EmptyState icon={<Eye />} title={filter ? 'No matching views' : 'No views in this namespace'} className="m-3 border-0">
              {filter ? 'Try a different filter.' : 'Views are saved SQL queries created by engines such as Spark or Trino.'}
            </EmptyState>
          }
        />
      )}
      {pending?.kind === 'rename-view' && (
        <RenameDialog kind="view" cluster={cluster} wh={wh} ns={ns} name={pending.name} open onOpenChange={(v) => !v && setPending(null)} onRenamed={(nns, n) => navigate(paths.view(cluster, wh, nns, n))} />
      )}
      {pending?.kind === 'drop-view' && <DropViewDialog cluster={cluster} wh={wh} ns={ns} name={pending.name} open onOpenChange={(v) => !v && setPending(null)} />}
    </div>
  )
}
