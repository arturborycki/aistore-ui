import { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import * as D from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Activity, LaptopMinimal, LayoutDashboard, LoaderCircle, LogOut, Monitor, Moon, Search, Sun, Warehouse } from 'lucide-react'
import { useAuth } from '@/auth/AuthContext'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Kbd } from '@/components/ui/kbd'
import { searchCatalog, type SearchHit } from '@/lib/catalog'
import { ossie } from '@/lib/ossie'
import { useSemanticEnabled } from '@/features/semantic/ModelsTab'
import type { Namespace } from '@/lib/namespace'
import { useTheme } from './theme'
import { paths } from './paths'

export function useCommandPalette() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return { open, setOpen }
}

const groupCls =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle'

function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

const itemCls =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-[13px] data-[selected=true]:bg-surface [&_svg]:size-4 [&_svg]:shrink-0'

export function CommandPalette({ cluster, open, onOpenChange }: { cluster: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { logout } = useAuth()
  const { setTheme } = useTheme()
  const [input, setInput] = useState('')
  const term = useDebounced(input.trim(), 250)
  const [seenOpen, setSeenOpen] = useState(open)
  if (seenOpen !== open) {
    setSeenOpen(open)
    if (open) setInput('')
  }
  // Beyond what the explorer has loaded, ask the server to search the whole catalog.
  const remote = useQuery({
    queryKey: ['search', cluster, term],
    queryFn: ({ signal }) => searchCatalog(cluster, term, signal),
    enabled: open && term.length >= 2,
    staleTime: 30_000,
  })

  // Search everything the explorer has already loaded (no extra catalog calls).
  const { warehouses, namespaces, leaves } = useMemo(() => {
    const leaves: { kind: 'table' | 'view'; wh: string; ns: Namespace; name: string }[] = []
    if (!open) return { warehouses: [] as string[], namespaces: [] as { wh: string; ns: Namespace }[], leaves }
    const whs = qc.getQueryData<string[]>(['tree', cluster, 'warehouses']) ?? []
    const nss: { wh: string; ns: Namespace }[] = []
    for (const [key, data] of qc.getQueriesData<Namespace[]>({ queryKey: ['tree', cluster, 'ns'] })) {
      const wh = key[3] as string
      for (const ns of data ?? []) nss.push({ wh, ns })
    }
    for (const kind of ['tables', 'views'] as const) {
      for (const [key, data] of qc.getQueriesData<{ name: string; namespace: string[] }[]>({ queryKey: ['tree', cluster, kind] })) {
        for (const id of data ?? []) leaves.push({ kind: kind === 'tables' ? 'table' : 'view', wh: key[3] as string, ns: id.namespace, name: id.name })
      }
    }
    return { warehouses: whs, namespaces: nss, leaves }
  }, [open, qc, cluster])

  const semanticOn = useSemanticEnabled()
  const semantic = useQuery({
    queryKey: ['semantic-search', cluster, term],
    queryFn: ({ signal }) => ossie.search(cluster, term, signal),
    enabled: open && semanticOn && term.length >= 2,
    staleTime: 30_000,
  })

  const loadedKeys = useMemo(() => {
    const k = new Set<string>()
    warehouses.forEach((wh) => k.add(`warehouse:${wh}`))
    namespaces.forEach(({ wh, ns }) => k.add(`namespace:${wh}/${ns.join('\u001f')}`))
    leaves.forEach((l) => k.add(`${l.kind}:${l.wh}/${l.ns.join('\u001f')}/${l.name}`))
    return k
  }, [warehouses, namespaces, leaves])
  const hitKey = (h: SearchHit) =>
    h.kind === 'warehouse' ? `warehouse:${h.warehouse}` : h.kind === 'namespace' ? `namespace:${h.warehouse}/${[...(h.namespace ?? []), h.name].join('\u001f')}` : `${h.kind}:${h.warehouse}/${(h.namespace ?? []).join('\u001f')}/${h.name}`
  const extra = (remote.data?.results ?? []).filter((h) => !loadedKeys.has(hitKey(h)))
  const hitPath = (h: SearchHit) => {
    const parent = h.namespace ?? []
    switch (h.kind) {
      case 'warehouse':
        return paths.warehouse(cluster, h.warehouse)
      case 'namespace':
        return paths.namespace(cluster, h.warehouse, [...parent, h.name])
      case 'table':
        return paths.table(cluster, h.warehouse, parent, h.name)
      case 'view':
        return paths.view(cluster, h.warehouse, parent, h.name)
    }
  }

  const go = (to: string) => {
    onOpenChange(false)
    navigate(to)
  }

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-fade-in" />
        <D.Content className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-[var(--radius-modal)] border border-border bg-bg shadow-pop data-[state=open]:animate-pop-in">
          <D.Title className="sr-only">Command palette</D.Title>
          <D.Description className="sr-only">Search the catalog and run commands</D.Description>
          <Command loop>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-subtle" />
              <Command.Input autoFocus value={input} onValueChange={setInput} aria-label="Search the catalog or run a command" placeholder="Search tables, views, namespaces… or run a command" className="h-11 flex-1 bg-transparent text-[14px] outline-none placeholder:text-subtle" />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">
                {remote.isFetching ? 'Searching the catalog…' : input.trim().length === 1 ? 'Type at least two characters to search the whole catalog.' : 'No results.'}
              </Command.Empty>
              <Command.Group heading="Go to" className={groupCls}>
                <Command.Item className={itemCls} onSelect={() => go(paths.overview(cluster))}>
                  <LayoutDashboard className="text-muted" /> Overview
                </Command.Item>
                <Command.Item className={itemCls} onSelect={() => go(paths.warehouses(cluster))}>
                  <Warehouse className="text-muted" /> Warehouses
                </Command.Item>
                <Command.Item className={itemCls} onSelect={() => go(paths.activity(cluster))}>
                  <Activity className="text-muted" /> Activity
                </Command.Item>
                <Command.Item className={itemCls} onSelect={() => go(paths.sessions(cluster))}>
                  <LaptopMinimal className="text-muted" /> Sessions
                </Command.Item>
              </Command.Group>
              {warehouses.length > 0 && (
                <Command.Group heading="Warehouses" className={groupCls}>
                  {warehouses.map((wh) => (
                    <Command.Item key={wh} value={`warehouse ${wh}`} className={itemCls} onSelect={() => go(paths.warehouse(cluster, wh))}>
                      <EntityIcon kind="warehouse" />
                      <span className="font-mono text-[12.5px]">{wh}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {namespaces.length > 0 && (
                <Command.Group heading="Namespaces" className={groupCls}>
                  {namespaces.map(({ wh, ns }) => (
                    <Command.Item key={`${wh}/${ns.join('\u001f')}`} value={`namespace ${wh}.${ns.join('.')}`} className={itemCls} onSelect={() => go(paths.namespace(cluster, wh, ns))}>
                      <EntityIcon kind="namespace" />
                      <span className="font-mono text-[12.5px]">
                        <span className="text-subtle">{wh}.</span>
                        {ns.join('.')}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {leaves.length > 0 && (
                <Command.Group heading="Tables & views" className={groupCls}>
                  {leaves.map((l) => (
                    <Command.Item
                      key={`${l.kind}:${l.wh}/${l.ns.join('\u001f')}/${l.name}`}
                      value={`${l.kind} ${l.wh}.${l.ns.join('.')}.${l.name}`}
                      className={itemCls}
                      onSelect={() => go(l.kind === 'table' ? paths.table(cluster, l.wh, l.ns, l.name) : paths.view(cluster, l.wh, l.ns, l.name))}
                    >
                      <EntityIcon kind={l.kind} />
                      <span className="font-mono text-[12.5px]">
                        <span className="text-subtle">{l.wh}.{l.ns.join('.')}.</span>
                        {l.name}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {term.length >= 2 && (remote.isFetching || extra.length > 0 || remote.data?.truncated) && (
                <Command.Group heading="Across the catalog" className={groupCls} forceMount>
                  {remote.isFetching && extra.length === 0 && (
                    <Command.Loading>
                      <div className="flex h-8 items-center gap-2 px-2 text-[12.5px] text-muted">
                        <LoaderCircle className="size-4 animate-spin" /> Searching the catalog…
                      </div>
                    </Command.Loading>
                  )}
                  {extra.map((h) => {
                    const parent = h.namespace ?? []
                    const prefix = [h.warehouse, ...parent].join('.')
                    return (
                      <Command.Item key={hitKey(h)} value={`${h.kind} ${prefix}.${h.name} ${term}`} className={itemCls} onSelect={() => go(hitPath(h))}>
                        <EntityIcon kind={h.kind} />
                        <span className="font-mono text-[12.5px]">
                          {h.kind !== 'warehouse' && <span className="text-subtle">{prefix}.</span>}
                          {h.name}
                        </span>
                      </Command.Item>
                    )
                  })}
                  {remote.data && (remote.data.truncated || remote.data.skipped > 0) && (
                    <div className="px-2 py-1.5 text-[11.5px] text-subtle" role="note">
                      {remote.data.truncated && 'Showing the first matches; refine the search to see more. '}
                      {remote.data.skipped > 0 && `${remote.data.skipped} location${remote.data.skipped === 1 ? ' was' : 's were'} skipped because you may not list ${remote.data.skipped === 1 ? 'it' : 'them'}.`}
                    </div>
                  )}
                </Command.Group>
              )}
              {term.length >= 2 && (semantic.data?.results.length ?? 0) > 0 && (
                <Command.Group heading="Semantic models" className={groupCls} forceMount>
                  {semantic.data!.results.map((h) => {
                    const tab = h.kind === 'metric' ? 'metrics' : h.kind === 'relationship' ? 'relationships' : h.kind === 'model' ? undefined : 'datasets'
                    return (
                      <Command.Item
                        key={`${h.kind}:${h.warehouse}/${h.namespace.join('.')}/${h.model}/${h.dataset ?? ''}/${h.name}`}
                        value={`semantic ${h.kind} ${h.model} ${h.dataset ?? ''} ${h.name} ${h.match ?? ''} ${term}`}
                        className={itemCls}
                        onSelect={() => go(paths.model(cluster, h.warehouse, h.namespace, h.model, tab))}
                      >
                        <EntityIcon kind="model" />
                        <span className="min-w-0 truncate">
                          <span className="font-mono text-[12.5px]">
                            {h.kind === 'model' ? h.name : h.kind === 'field' ? `${h.dataset}.${h.name}` : h.name}
                          </span>
                          <span className="ml-2 text-[11.5px] text-subtle">
                            {h.kind} in {h.model}
                            {h.match ? ` · “${h.match}”` : ''}
                          </span>
                        </span>
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              )}
              <Command.Group heading="Preferences" className={groupCls}>
                <Command.Item className={itemCls} onSelect={() => { setTheme('light'); onOpenChange(false) }}>
                  <Sun className="text-muted" /> Light theme
                </Command.Item>
                <Command.Item className={itemCls} onSelect={() => { setTheme('dark'); onOpenChange(false) }}>
                  <Moon className="text-muted" /> Dark theme
                </Command.Item>
                <Command.Item className={itemCls} onSelect={() => { setTheme('system'); onOpenChange(false) }}>
                  <Monitor className="text-muted" /> System theme
                </Command.Item>
                <Command.Item className={itemCls} onSelect={() => { onOpenChange(false); void logout() }}>
                  <LogOut className="text-muted" /> Sign out
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
