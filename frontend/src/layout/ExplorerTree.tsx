import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { ChevronRight, LoaderCircle, LockKeyhole, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { listAllNamespaces, listAllTables, listAllViews, listAllWarehouses } from '@/lib/catalog'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { decodeNamespaceParam, encodeNamespace, sameNamespace, type Namespace } from '@/lib/namespace'
import { getPref, setPref } from '@/lib/prefs'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Tooltip } from '@/components/ui/tooltip'
import { paths } from './paths'

const INDENT = 14

export const treeKeys = {
  warehouses: (cluster: string) => ['tree', cluster, 'warehouses'] as const,
  namespaces: (cluster: string, wh: string, parent: Namespace) => ['tree', cluster, 'ns', wh, parent.join('\u001f')] as const,
  tables: (cluster: string, wh: string, ns: Namespace) => ['tree', cluster, 'tables', wh, ns.join('\u001f')] as const,
  views: (cluster: string, wh: string, ns: Namespace) => ['tree', cluster, 'views', wh, ns.join('\u001f')] as const,
}

/** Tables and views of an expanded namespace (leaf rows). */
function LeafNodes({ cluster, wh, ns, depth }: { cluster: string; wh: string; ns: Namespace; depth: number }) {
  const params = useParams()
  const activeNs = decodeNamespaceParam(params.ns)
  const here = params.wh === wh && sameNamespace(activeNs, ns)
  const tables = useQuery({ queryKey: treeKeys.tables(cluster, wh, ns), queryFn: () => listAllTables(cluster, wh, ns), staleTime: 30_000 })
  const views = useQuery({ queryKey: treeKeys.views(cluster, wh, ns), queryFn: () => listAllViews(cluster, wh, ns), staleTime: 30_000 })
  const row = (kind: 'table' | 'view', name: string) => (
    <Row
      key={`${kind}:${name}`}
      depth={depth}
      to={kind === 'table' ? paths.table(cluster, wh, ns, name) : paths.view(cluster, wh, ns, name)}
      active={here && (kind === 'table' ? params.table === name : params.view === name)}
      expandable={false}
      open={false}
      onToggle={() => {}}
      icon={<EntityIcon kind={kind} />}
      label={name}
    />
  )
  return (
    <>
      {tables.isError && <div style={{ paddingLeft: depth * INDENT + 24 }}>{nodeError(tables.error)}</div>}
      {tables.data?.map((t) => row('table', t.name))}
      {views.data?.map((v) => row('view', v.name))}
    </>
  )
}

function useExpanded(cluster: string) {
  const key = `tree-expanded:${cluster}`
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(getPref<string[]>(key, [])))
  const toggle = (id: string, open?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      const want = open ?? !next.has(id)
      if (want) next.add(id)
      else next.delete(id)
      setPref(key, [...next].slice(-300))
      return next
    })
  return { expanded, toggle }
}

function nodeError(error: unknown) {
  const denied = error instanceof ApiError && error.isAccessDenied
  return (
    <Tooltip content={denied ? `No access${(error as ApiError).action ? ` (${(error as ApiError).action})` : ''}` : (error as Error)?.message}>
      <span className="flex h-6 items-center gap-1.5 text-[12px] text-subtle">
        {denied ? <LockKeyhole className="size-3.5" /> : <TriangleAlert className="size-3.5 text-warning" />}
        {denied ? 'No access' : 'Failed to load'}
      </span>
    </Tooltip>
  )
}

function Row({
  depth,
  to,
  active,
  expandable,
  open,
  onToggle,
  icon,
  label,
  loading,
}: {
  depth: number
  to: string
  active: boolean
  expandable: boolean
  open: boolean
  onToggle: () => void
  icon: React.ReactNode
  label: string
  loading?: boolean
}) {
  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-selected={active}
      className={cn(
        'group relative flex h-7 items-center rounded-[5px] pr-1 text-[13px]',
        active ? 'bg-accent-subtle text-accent-text' : 'text-fg hover:bg-surface',
      )}
      style={{ paddingLeft: depth * INDENT + 2 }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
        onClick={onToggle}
        className={cn('flex size-5 shrink-0 items-center justify-center rounded text-subtle hover:text-fg', !expandable && 'invisible')}
      >
        {loading ? <LoaderCircle className="size-3 animate-spin" /> : <ChevronRight className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />}
      </button>
      <Link
        to={to}
        onDoubleClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 focus-visible:outline-offset-[-2px]"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' && expandable && !open) {
            e.preventDefault()
            onToggle()
          }
          if (e.key === 'ArrowLeft' && expandable && open) {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        {icon}
        <span className="truncate">{label}</span>
      </Link>
    </div>
  )
}

function NamespaceNodes({
  cluster,
  wh,
  parent,
  depth,
  expanded,
  toggle,
  activeWh,
  activeNs,
}: {
  cluster: string
  wh: string
  parent: Namespace
  depth: number
  expanded: Set<string>
  toggle: (id: string, open?: boolean) => void
  activeWh?: string
  activeNs: Namespace
}) {
  const params = useParams()
  const leafActive = !!(params.table || params.view)
  const q = useQuery({
    queryKey: treeKeys.namespaces(cluster, wh, parent),
    queryFn: () => listAllNamespaces(cluster, wh, parent),
    staleTime: 30_000,
  })
  if (q.isPending) return null
  if (q.isError) return <div style={{ paddingLeft: depth * INDENT + 24 }}>{nodeError(q.error)}</div>
  const items = [...q.data].sort((a, b) => a[a.length - 1].localeCompare(b[b.length - 1]))
  if (items.length === 0 && parent.length === 0) {
    return (
      <div className="flex h-6 items-center text-[12px] text-subtle" style={{ paddingLeft: depth * INDENT + 24 }}>
        No namespaces
      </div>
    )
  }
  return (
    <div role="group">
      {items.map((ns) => {
        const id = `${wh}/${encodeNamespace(ns)}`
        const open = expanded.has(id)
        const active = activeWh === wh && sameNamespace(ns, activeNs) && !leafActive
        return (
          <div key={id}>
            <Row
              depth={depth}
              to={paths.namespace(cluster, wh, ns)}
              active={active}
              expandable
              open={open}
              onToggle={() => toggle(id)}
              icon={<EntityIcon kind="namespace" open={open} />}
              label={ns[ns.length - 1]}
            />
            {open && (
              <>
                <NamespaceNodes cluster={cluster} wh={wh} parent={ns} depth={depth + 1} expanded={expanded} toggle={toggle} activeWh={activeWh} activeNs={activeNs} />
                <LeafNodes cluster={cluster} wh={wh} ns={ns} depth={depth + 1} />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ExplorerTree({ cluster }: { cluster: string }) {
  const params = useParams()
  const activeWh = params.wh
  const activeNs = useMemo(() => decodeNamespaceParam(params.ns), [params.ns])
  const { expanded, toggle } = useExpanded(cluster)
  const [filter, setFilter] = useState('')
  const q = useQuery({ queryKey: treeKeys.warehouses(cluster), queryFn: () => listAllWarehouses(cluster), staleTime: 30_000 })

  // Reveal the current route in the tree (expand its warehouse and ancestors).
  const nsKey = activeNs.join('\u001f')
  useEffect(() => {
    if (!activeWh) return
    toggle(activeWh, true)
    const upto = params.table || params.view ? activeNs.length : activeNs.length - 1
    for (let i = 1; i <= upto; i++) toggle(`${activeWh}/${encodeNamespace(activeNs.slice(0, i))}`, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWh, nsKey, params.table, params.view])

  const warehouses = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (q.data ?? []).filter((w) => !f || w.toLowerCase().includes(f)).sort()
  }, [q.data, filter])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-3">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-subtle">Explorer</span>
        <Tooltip content="Refresh">
          <button
            type="button"
            onClick={() => q.refetch()}
            className="rounded p-1 text-subtle hover:bg-surface hover:text-fg"
            aria-label="Refresh explorer"
          >
            <RefreshCw className={cn('size-3.5', q.isFetching && 'animate-spin')} />
          </button>
        </Tooltip>
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter warehouses"
            aria-label="Filter warehouses"
            className="h-7 w-full rounded-[var(--radius-control)] border border-border bg-bg pl-7 pr-2 text-[12.5px] placeholder:text-subtle focus:border-accent focus:outline-none"
          />
        </div>
      </div>
      <div role="tree" aria-label="Catalog explorer" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {q.isPending &&
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex h-7 items-center gap-2 pl-6">
              <div className="h-3 w-24 animate-pulse rounded bg-surface" />
            </div>
          ))}
        {q.isError && <div className="px-2">{nodeError(q.error)}</div>}
        {q.isSuccess && warehouses.length === 0 && (
          <p className="px-2 py-2 text-[12px] text-subtle">{filter ? 'No matching warehouses' : 'No warehouses you can access'}</p>
        )}
        {warehouses.map((wh) => {
          const open = expanded.has(wh)
          return (
            <div key={wh}>
              <Row
                depth={0}
                to={paths.warehouse(cluster, wh)}
                active={activeWh === wh && activeNs.length === 0}
                expandable
                open={open}
                onToggle={() => toggle(wh)}
                icon={<EntityIcon kind="warehouse" />}
                label={wh}
              />
              {open && <NamespaceNodes cluster={cluster} wh={wh} parent={[]} depth={1} expanded={expanded} toggle={toggle} activeWh={activeWh} activeNs={activeNs} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
