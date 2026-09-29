import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ListParams, StatsPage } from './catalog'
import type { SortState } from '@/components/ui/data-table'

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

/**
 * Server-side search / sort / pagination for AIStor "statistics mode" lists.
 * AIStor caches the listing on one node and returns a routing token
 * (X-Minio-Ui-List-Token) that must accompany later pages of the same listing.
 */
export function useStatsList<T>(baseKey: readonly unknown[], fetchPage: (p: ListParams) => Promise<StatsPage<T>>, pageSize = 50, initialSort: SortState = { key: 'name', order: 'asc' }) {
  const [search, setSearch] = useState('')
  const [sort, setSortState] = useState<SortState>(initialSort)
  const [page, setPage] = useState(0)
  const debounced = useDebounced(search)
  const tokens = useRef(new Map<string, string>())
  const sig = `${debounced}|${sort.key}|${sort.order}`

  useEffect(() => setPage(0), [sig])

  const query = useQuery({
    queryKey: [...baseKey, 'stats-list', sig, page, pageSize],
    queryFn: async () => {
      const r = await fetchPage({ search: debounced, page, pageSize, sort: sort.key, sortOrder: sort.order, uiToken: page > 0 ? tokens.current.get(sig) : undefined })
      if (r.uiToken) tokens.current.set(sig, r.uiToken)
      return r
    },
    placeholderData: keepPreviousData,
  })

  return {
    query,
    search,
    setSearch,
    sort,
    setSort: (s: SortState) => setSortState(s),
    page,
    setPage,
    pageSize,
  }
}
