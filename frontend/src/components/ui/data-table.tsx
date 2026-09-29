import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './button'
import { Skeleton } from './skeleton'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** server-side sort key, when sortable */
  sortKey?: string
  align?: 'left' | 'right'
  className?: string
  width?: string
}

export interface SortState {
  key: string
  order: 'asc' | 'desc'
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  sort,
  onSort,
  onRowClick,
  empty,
  rowActions,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  sort?: SortState
  onSort?: (s: SortState) => void
  onRowClick?: (row: T) => void
  empty?: ReactNode
  rowActions?: (row: T) => ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-[1] bg-bg-subtle">
          <tr className="border-b border-border">
            {columns.map((c) => {
              const active = sort && c.sortKey && sort.key === c.sortKey
              const ariaSort = active ? (sort!.order === 'asc' ? 'ascending' : 'descending') : c.sortKey ? 'none' : undefined
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={ariaSort}
                  style={c.width ? { width: c.width } : undefined}
                  className={cn('h-8 px-3 text-left text-[11.5px] font-medium text-muted', c.align === 'right' && 'text-right', c.className)}
                >
                  {c.sortKey && onSort ? (
                    <button
                      type="button"
                      className={cn('inline-flex items-center gap-1 hover:text-fg', c.align === 'right' && 'flex-row-reverse', active && 'text-fg')}
                      onClick={() =>
                        onSort({ key: c.sortKey!, order: active && sort!.order === 'asc' ? 'desc' : active ? 'asc' : c.sortKey === 'name' ? 'asc' : 'desc' })
                      }
                    >
                      {c.header}
                      {active ? (
                        sort!.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                      ) : (
                        <ArrowUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              )
            })}
            {rowActions && <th className="w-10" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                {columns.map((c) => (
                  <td key={c.key} className="h-9 px-3">
                    <Skeleton className={cn('h-3.5', c.align === 'right' ? 'ml-auto w-14' : 'w-32')} />
                  </td>
                ))}
                {rowActions && <td />}
              </tr>
            ))}
          {!loading &&
            rows.map((r) => (
              <tr
                key={rowKey(r)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cn('group border-b border-border last:border-0 hover:bg-bg-subtle', onRowClick && 'cursor-pointer')}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('h-9 px-3', c.align === 'right' && 'text-right tabular', c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
                {rowActions && (
                  <td className="px-1 text-right" onClick={(e) => e.stopPropagation()}>
                    {rowActions(r)}
                  </td>
                )}
              </tr>
            ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && empty}
    </div>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  count,
  onPage,
}: {
  page: number
  pageSize: number
  total: number | null
  count: number
  onPage: (p: number) => void
}) {
  const from = count === 0 ? 0 : page * pageSize + 1
  const to = page * pageSize + count
  const pages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null
  const hasNext = pages != null ? page + 1 < pages : count === pageSize
  return (
    <div className="flex items-center justify-between gap-3 px-1 pt-2 text-[12px] text-muted">
      <span className="tabular">
        {total != null ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : count ? `${from}–${to}` : ''}
      </span>
      <div className="flex items-center gap-1">
        {pages != null && (
          <span className="mr-1 tabular">
            Page {page + 1} of {pages}
          </span>
        )}
        <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={!hasNext} onClick={() => onPage(page + 1)}>
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
