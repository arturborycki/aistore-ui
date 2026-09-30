import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, Link } from 'react-router'
import { LoginPage } from '@/auth/LoginPage'
import { RequireAuth, useMe } from '@/auth/AuthContext'
import { StepUpComplete, StepUpProvider } from '@/auth/StepUp'
import { AppShell } from '@/layout/AppShell'
import { paths } from '@/layout/paths'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/states'

// Pages load on demand so the first paint only needs the shell.
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })))
const OverviewPage = named(() => import('@/features/overview/OverviewPage'), 'OverviewPage')
const WarehousesPage = named(() => import('@/features/warehouses/WarehousesPage'), 'WarehousesPage')
const WarehousePage = named(() => import('@/features/warehouses/WarehousePage'), 'WarehousePage')
const NamespacePage = named(() => import('@/features/namespaces/NamespacePage'), 'NamespacePage')
const ActivityPage = named(() => import('@/features/activity/ActivityPage'), 'ActivityPage')
const SessionsPage = named(() => import('@/features/sessions/SessionsPage'), 'SessionsPage')
const TablePage = named(() => import('@/features/tables/TablePage'), 'TablePage')
const ViewPage = named(() => import('@/features/views/ViewPage'), 'ViewPage')
const CreateTablePage = named(() => import('@/features/tables/CreateTablePage'), 'CreateTablePage')
const ModelPage = named(() => import('@/features/semantic/ModelPage'), 'ModelPage')

function HomeRedirect() {
  const me = useMe()
  const first = me.clusters.find((c) => c.available) ?? me.clusters[0]
  if (!first) return <EmptyState title="No clusters configured" className="m-8">Ask an administrator to configure an AIStor cluster.</EmptyState>
  return <Navigate to={paths.overview(first.id)} replace />
}

function NotFound() {
  return (
    <EmptyState title="Page not found" className="m-8" action={<Link to="/" className="text-accent-text hover:underline">Go home</Link>}>
      The page you are looking for does not exist.
    </EmptyState>
  )
}

function PageFallback() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-12 w-1/3" />
      <Skeleton className="h-64" />
    </div>
  )
}

const page = (el: React.ReactNode) => <Suspense fallback={<PageFallback />}>{el}</Suspense>

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/step-up-complete" element={<StepUpComplete />} />
      <Route
        element={
          <RequireAuth>
            <StepUpProvider>
              <AppShell />
            </StepUpProvider>
          </RequireAuth>
        }
      >
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/c/:cluster" element={page(<OverviewPage />)} />
        <Route path="/c/:cluster/warehouses" element={page(<WarehousesPage />)} />
        <Route path="/c/:cluster/wh/:wh" element={page(<WarehousePage />)} />
        <Route path="/c/:cluster/wh/:wh/ns/:ns" element={page(<NamespacePage />)} />
        <Route path="/c/:cluster/wh/:wh/ns/:ns/new-table" element={page(<CreateTablePage />)} />
        <Route path="/c/:cluster/wh/:wh/ns/:ns/t/:table" element={page(<TablePage />)} />
        <Route path="/c/:cluster/wh/:wh/ns/:ns/v/:view" element={page(<ViewPage />)} />
        <Route path="/c/:cluster/wh/:wh/ns/:ns/m/:model" element={page(<ModelPage />)} />
        <Route path="/c/:cluster/activity" element={page(<ActivityPage />)} />
        <Route path="/c/:cluster/sessions" element={page(<SessionsPage />)} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
