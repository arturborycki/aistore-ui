import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router'
import { Activity, ChevronsUpDown, LaptopMinimal, LayoutDashboard, LogOut, Monitor, Moon, PanelLeft, Search, Server, ShieldCheck, Sun, Warehouse } from 'lucide-react'
import { useAuth, useMe } from '@/auth/AuthContext'
import { SessionWarnings } from '@/auth/SessionWarnings'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { getPref, setPref } from '@/lib/prefs'
import { BrandMark } from './Brand'
import { Breadcrumbs } from './Breadcrumbs'
import { CommandPalette, useCommandPalette } from './CommandPalette'
import { ExplorerTree } from './ExplorerTree'
import { paths } from './paths'
import { useTheme, type ThemePref } from './theme'
import { ThemeToggle } from './ThemeToggle'
import { useCluster } from './useCluster'

const MIN_W = 220
const MAX_W = 380
const NARROW = '(max-width: 767px)'

/** True below the md breakpoint, where the sidebar becomes an overlay. */
function useNarrow() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(NARROW)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(NARROW).matches,
  )
}

function ClusterSwitcher({ cluster }: { cluster: string }) {
  const me = useMe()
  const navigate = useNavigate()
  const current = me.clusters.find((c) => c.id === cluster)
  if (me.clusters.length <= 1) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-[var(--radius-control)] px-2 text-[13px]">
        <Server className="size-4 text-muted" />
        <span className="truncate font-medium">{current?.name ?? cluster}</span>
      </div>
    )
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] border border-border bg-bg px-2 text-left text-[13px] hover:bg-surface">
          <Server className="size-4 text-muted" />
          <span className="flex-1 truncate font-medium">{current?.name ?? cluster}</span>
          <ChevronsUpDown className="size-3.5 text-subtle" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="w-60">
        <MenuLabel>Clusters</MenuLabel>
        <MenuRadioGroup value={cluster} onValueChange={(id) => navigate(paths.overview(id))}>
          {me.clusters.map((c) => (
            <MenuRadioItem key={c.id} value={c.id}>
              <span className={cn(!c.available && 'text-subtle')}>{c.name}</span>
              {!c.available && <span className="ml-1 text-[11px] text-subtle">(unavailable)</span>}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  )
}

function NavItem({ to, icon, children, end }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex h-7 items-center gap-2 rounded-[5px] px-2 text-[13px] [&_svg]:size-4',
          isActive ? 'bg-surface font-medium text-fg [&_svg]:text-fg' : 'text-muted hover:bg-surface hover:text-fg',
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  )
}

function UserMenu({ cluster }: { cluster: string }) {
  const me = useMe()
  const navigate = useNavigate()
  const { logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const initials = (me.user.name || me.user.username)
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('')
  const methodLabel = { oidc: 'Single sign-on', ldap: 'LDAP', builtin: 'Access key' }[me.user.method]
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="flex h-10 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left hover:bg-surface" aria-label="Account menu">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-[11px] font-semibold text-accent-text">{initials}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{me.user.name || me.user.username}</span>
            <span className="block truncate text-[11px] text-subtle">{methodLabel}</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-subtle" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="w-64">
        <div className="px-2 py-1.5">
          <div className="truncate text-[13px] font-medium">{me.user.username}</div>
          {me.user.email && <div className="truncate text-[12px] text-muted">{me.user.email}</div>}
          {me.user.admin && (
            <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent-text">
              <ShieldCheck className="size-3" /> Catalog administrator
            </div>
          )}
        </div>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        <MenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
          <MenuRadioItem value="system" icon={<Monitor />}>System</MenuRadioItem>
          <MenuRadioItem value="light" icon={<Sun />}>Light</MenuRadioItem>
          <MenuRadioItem value="dark" icon={<Moon />}>Dark</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<LaptopMinimal />} onSelect={() => navigate(paths.sessions(cluster))}>
          Sessions & devices
        </MenuItem>
        <MenuItem icon={<LogOut />} onSelect={() => void logout()}>
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

export function AppShell() {
  const cluster = useCluster()
  const params = useParams()
  const location = useLocation()
  const palette = useCommandPalette()
  const [width, setWidth] = useState(() => getPref('sidebar-width', 264))
  const [collapsed, setCollapsed] = useState(() => getPref('sidebar-collapsed', false))
  const dragging = useRef(false)
  const narrow = useNarrow()
  const [mobileOpen, setMobileOpen] = useState(false)
  // Navigating closes the overlay sidebar on small screens.
  const [seenPath, setSeenPath] = useState(location.pathname)
  if (seenPath !== location.pathname) {
    setSeenPath(location.pathname)
    setMobileOpen(false)
  }
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])
  const showSidebar = narrow ? mobileOpen : !collapsed

  const onDrag = useCallback((e: React.PointerEvent) => {
    dragging.current = true
    const startX = e.clientX
    const startW = width
    const move = (ev: PointerEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX))
      setWidth(w)
    }
    const up = (ev: PointerEvent) => {
      dragging.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setPref('sidebar-width', Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [width])

  const toggleSidebar = () => {
    if (narrow) {
      setMobileOpen((v) => !v)
      return
    }
    setCollapsed((v) => {
      setPref('sidebar-collapsed', !v)
      return !v
    })
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {narrow && mobileOpen && <div className="fixed inset-0 z-30 bg-black/40" aria-hidden onClick={() => setMobileOpen(false)} />}
      {showSidebar && (
        <aside
          id="sidebar"
          className={cn('flex shrink-0 flex-col border-r border-border bg-sidebar', narrow ? 'fixed inset-y-0 left-0 z-40 shadow-xl' : 'relative')}
          style={{ width: narrow ? Math.min(300, window.innerWidth - 48) : width }}
          aria-label="Sidebar"
        >
          <div className="flex h-12 items-center gap-2 px-3">
            <Link to={paths.overview(cluster)} className="flex items-center gap-2">
              <BrandMark />
              <span className="text-[14px] font-semibold tracking-tight">AIStor Catalog</span>
            </Link>
          </div>
          <div className="px-2">
            <ClusterSwitcher cluster={cluster} />
          </div>
          <nav className="mt-2 flex flex-col gap-0.5 px-2" aria-label="Main">
            <NavItem to={paths.overview(cluster)} icon={<LayoutDashboard />} end>
              Overview
            </NavItem>
            <NavItem to={paths.warehouses(cluster)} icon={<Warehouse />}>
              Warehouses
            </NavItem>
            <NavItem to={paths.activity(cluster)} icon={<Activity />}>
              Activity
            </NavItem>
            <NavItem to={paths.sessions(cluster)} icon={<LaptopMinimal />}>
              Sessions
            </NavItem>
          </nav>
          <div className="mx-3 mt-2 h-px bg-border" />
          <ExplorerTree key={cluster} cluster={cluster} />
          <div className="border-t border-border p-2">
            <UserMenu cluster={cluster} />
          </div>
          {!narrow && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={onDrag}
            className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/20"
          />
          )}
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <Tooltip content={showSidebar ? 'Hide sidebar' : 'Show sidebar'}>
            <button onClick={toggleSidebar} className="rounded p-1.5 text-muted hover:bg-surface hover:text-fg" aria-label="Toggle sidebar" aria-expanded={showSidebar} aria-controls="sidebar">
              <PanelLeft className="size-4" />
            </button>
          </Tooltip>
          <div className="min-w-0 flex-1 overflow-hidden">
            <Breadcrumbs cluster={cluster} />
          </div>
          <ThemeToggle />
          <button
            onClick={() => palette.setOpen(true)}
            aria-label="Search catalog"
            className="flex h-8 w-64 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-bg-subtle px-2.5 text-[12.5px] text-subtle hover:border-border-strong hover:text-muted max-md:w-auto"
          >
            <Search className="size-3.5" />
            <span className="flex-1 text-left max-md:hidden">Search catalog…</span>
            <Kbd>⌘K</Kbd>
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto" key={`${params.cluster}`}>
          <div className="mx-auto w-full max-w-[1400px] px-4 py-4 md:px-6 md:py-5" key={location.pathname}>
            <Outlet />
          </div>
        </main>
      </div>
      <CommandPalette cluster={cluster} open={palette.open} onOpenChange={palette.setOpen} />
      <SessionWarnings />
    </div>
  )
}
