import { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import * as D from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Activity, LayoutDashboard, LogOut, Monitor, Moon, Search, Sun, Warehouse } from 'lucide-react'
import { useAuth } from '@/auth/AuthContext'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Kbd } from '@/components/ui/kbd'
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

const itemCls =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-[13px] data-[selected=true]:bg-surface [&_svg]:size-4 [&_svg]:shrink-0'

export function CommandPalette({ cluster, open, onOpenChange }: { cluster: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { logout } = useAuth()
  const { setTheme } = useTheme()

  // Search everything the explorer has already loaded (no extra catalog calls).
  const { warehouses, namespaces } = useMemo(() => {
    if (!open) return { warehouses: [] as string[], namespaces: [] as { wh: string; ns: Namespace }[] }
    const whs = qc.getQueryData<string[]>(['tree', cluster, 'warehouses']) ?? []
    const nss: { wh: string; ns: Namespace }[] = []
    for (const [key, data] of qc.getQueriesData<Namespace[]>({ queryKey: ['tree', cluster, 'ns'] })) {
      const wh = key[3] as string
      for (const ns of data ?? []) nss.push({ wh, ns })
    }
    return { warehouses: whs, namespaces: nss }
  }, [open, qc, cluster])

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
              <Command.Input autoFocus placeholder="Jump to a warehouse or namespace, or run a command…" className="h-11 flex-1 bg-transparent text-[14px] outline-none placeholder:text-subtle" />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">No results.</Command.Empty>
              <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle">
                <Command.Item className={itemCls} onSelect={() => go(paths.overview(cluster))}>
                  <LayoutDashboard className="text-muted" /> Overview
                </Command.Item>
                <Command.Item className={itemCls} onSelect={() => go(paths.warehouses(cluster))}>
                  <Warehouse className="text-muted" /> Warehouses
                </Command.Item>
                <Command.Item className={itemCls} onSelect={() => go(paths.activity(cluster))}>
                  <Activity className="text-muted" /> Activity
                </Command.Item>
              </Command.Group>
              {warehouses.length > 0 && (
                <Command.Group heading="Warehouses" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle">
                  {warehouses.map((wh) => (
                    <Command.Item key={wh} value={`warehouse ${wh}`} className={itemCls} onSelect={() => go(paths.warehouse(cluster, wh))}>
                      <EntityIcon kind="warehouse" />
                      <span className="font-mono text-[12.5px]">{wh}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {namespaces.length > 0 && (
                <Command.Group heading="Namespaces" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle">
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
              <Command.Group heading="Preferences" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle">
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
