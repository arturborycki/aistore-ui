import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { LoaderCircle } from 'lucide-react'
import { ApiError, onSessionExpired, setCsrfToken } from '@/lib/api'
import { sessionApi, type Me } from '@/lib/session'

interface AuthValue {
  me: Me | null
  loading: boolean
  logout: () => Promise<void>
  setMe: (me: Me) => void
}

const Ctx = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()

  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        // Background: polling must not keep an unattended tab's session alive.
        return await sessionApi.me(true)
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  })

  const me = q.data ?? null
  useEffect(() => {
    setCsrfToken(me?.csrfToken ?? '')
  }, [me?.csrfToken])

  const setMe = useCallback(
    (m: Me) => {
      setCsrfToken(m.csrfToken)
      qc.setQueryData(['me'], m)
    },
    [qc],
  )

  // Any API call answering 401 means the server-side session is gone.
  useEffect(
    () =>
      onSessionExpired(() => {
        if (!qc.getQueryData(['me'])) return
        qc.setQueryData(['me'], null)
        qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' })
        const returnTo = location.pathname + location.search
        navigate(`/login?expired=1&returnTo=${encodeURIComponent(returnTo)}`, { replace: true })
      }),
    [qc, navigate, location.pathname, location.search],
  )

  const logout = useCallback(async () => {
    let redirect: string | undefined
    try {
      redirect = (await sessionApi.logout()).redirect
    } finally {
      setCsrfToken('')
      qc.clear()
      qc.setQueryData(['me'], null)
    }
    if (redirect) window.location.assign(redirect)
    else navigate('/login', { replace: true })
  }, [qc, navigate])

  const value = useMemo<AuthValue>(() => ({ me, loading: q.isPending, logout, setMe }), [me, q.isPending, logout, setMe])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}

export function useMe(): Me {
  const { me } = useAuth()
  if (!me) throw new Error('useMe requires an authenticated session')
  return me
}

export function FullScreenSpinner() {
  return (
    <div className="flex h-screen items-center justify-center text-muted" role="status" aria-label="Loading">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  )
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth()
  const location = useLocation()
  if (loading) return <FullScreenSpinner />
  if (!me) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return <>{children}</>
}
