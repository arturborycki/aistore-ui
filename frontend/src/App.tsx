import { Navigate, Route, Routes, Link } from 'react-router'
import { LoginPage } from '@/auth/LoginPage'
import { RequireAuth, useMe } from '@/auth/AuthContext'
import { StepUpComplete, StepUpProvider } from '@/auth/StepUp'
import { AppShell } from '@/layout/AppShell'
import { paths } from '@/layout/paths'
import { OverviewPage } from '@/features/overview/OverviewPage'
import { WarehousesPage } from '@/features/warehouses/WarehousesPage'
import { WarehousePage } from '@/features/warehouses/WarehousePage'
import { NamespacePage } from '@/features/namespaces/NamespacePage'
import { ActivityPage } from '@/features/activity/ActivityPage'
import { TablePage } from '@/features/tables/TablePage'
import { ViewPage } from '@/features/views/ViewPage'
import { EmptyState } from '@/components/ui/states'

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
        <Route path="/c/:cluster" element={<OverviewPage />} />
        <Route path="/c/:cluster/warehouses" element={<WarehousesPage />} />
        <Route path="/c/:cluster/wh/:wh" element={<WarehousePage />} />
        <Route path="/c/:cluster/wh/:wh/ns/:ns" element={<NamespacePage />} />
        <Route path="/c/:cluster/wh/:wh/ns/:ns/t/:table" element={<TablePage />} />
        <Route path="/c/:cluster/wh/:wh/ns/:ns/v/:view" element={<ViewPage />} />
        <Route path="/c/:cluster/activity" element={<ActivityPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
