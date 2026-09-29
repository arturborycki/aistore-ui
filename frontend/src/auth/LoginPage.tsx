import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useSearchParams, useNavigate } from 'react-router'
import { CircleAlert, KeyRound, LogIn, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { InlineError } from '@/components/ui/states'
import { Skeleton } from '@/components/ui/skeleton'
import { sessionApi } from '@/lib/session'
import { cn } from '@/lib/cn'
import { useAuth } from './AuthContext'
import { BrandMark } from '@/layout/Brand'

const errorMessages: Record<string, string> = {
  state: 'The sign-in attempt expired or was tampered with. Please try again.',
  idp: 'Your identity provider declined the sign-in.',
  idp_unavailable: 'The identity provider could not be reached. Try again shortly.',
  exchange: 'The identity provider response could not be verified.',
  sts: 'AIStor did not accept your identity. Ask an administrator to map your account to a policy.',
  session: 'A session could not be created. Try again.',
  stepup: 'Identity confirmation failed. Sign in again to continue.',
}

function safeReturnTo(v: string | null) {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/'
}

export function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { me, setMe } = useAuth()
  const returnTo = safeReturnTo(params.get('returnTo'))
  const providers = useQuery({ queryKey: ['providers'], queryFn: sessionApi.providers, staleTime: Infinity })
  const [mode, setMode] = useState<'ldap' | 'builtin' | null>(null)
  const [user, setUser] = useState('')
  const [secret, setSecret] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)

  // Popup used for SSO step-up landed here after a failure: report back and close.
  if (window.opener && params.get('error') === 'stepup') {
    window.opener.postMessage({ type: 'aistor-stepup', ok: false }, window.location.origin)
    window.close()
  }
  if (me) return <Navigate to={returnTo} replace />

  const p = providers.data
  const formModes = p ? ([p.ldap.enabled && 'ldap', p.builtin.enabled && 'builtin'].filter(Boolean) as ('ldap' | 'builtin')[]) : []
  const activeMode = mode ?? formModes[0] ?? null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeMode) return
    setPending(true)
    setError(null)
    try {
      const m = activeMode === 'ldap' ? await sessionApi.loginLdap(user, secret) : await sessionApi.loginBuiltin(user, secret)
      setSecret('')
      setMe(m)
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setPending(false)
    }
  }

  const banner = params.get('expired') ? 'Your session ended. Sign in again to continue.' : errorMessages[params.get('error') ?? '']

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-bg-subtle px-4">
      <div className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:20px_20px] opacity-60" />
      <div className="relative w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-10" />
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight">Sign in to AIStor Catalog</h1>
            <p className="mt-1 text-[12.5px] text-muted">You act with your own AIStor permissions.</p>
          </div>
        </div>

        <div className="rounded-[var(--radius-modal)] border border-border bg-bg p-5 shadow-pop">
          {banner && (
            <div className="mb-4 flex gap-2 rounded-[var(--radius-control)] bg-warning-subtle px-3 py-2 text-[12.5px] text-warning" role="alert">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{banner}</span>
            </div>
          )}
          {providers.isPending && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {providers.isError && <InlineError error={providers.error} />}

          {p?.oidc.enabled && (
            <a
              href={`/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-accent text-[13px] font-medium text-accent-fg hover:bg-accent-hover"
            >
              <ShieldCheck className="size-4" />
              Continue with {p.oidc.displayName}
            </a>
          )}

          {p?.oidc.enabled && formModes.length > 0 && (
            <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-subtle">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          {activeMode && (
            <form onSubmit={submit} className="flex flex-col gap-3">
              {formModes.length > 1 && (
                <div className="grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-surface p-0.5" role="tablist">
                  {formModes.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={activeMode === m}
                      onClick={() => {
                        setMode(m)
                        setError(null)
                      }}
                      className={cn('h-7 rounded-[5px] text-[12px] font-medium text-muted', activeMode === m && 'bg-bg text-fg shadow-sm')}
                    >
                      {m === 'ldap' ? p!.ldap.displayName : 'Access key'}
                    </button>
                  ))}
                </div>
              )}
              <Field label={activeMode === 'ldap' ? 'Username' : 'Access key'}>
                {(fp) => <Input {...fp} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" required autoFocus={!p?.oidc.enabled} />}
              </Field>
              <Field
                label={activeMode === 'ldap' ? 'Password' : 'Secret key'}
                hint={activeMode === 'builtin' ? 'Exchanged once for temporary credentials; never stored.' : undefined}
              >
                {(fp) => <Input {...fp} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="current-password" required />}
              </Field>
              <InlineError error={error} />
              <Button type="submit" variant={p?.oidc.enabled ? 'secondary' : 'primary'} size="lg" loading={pending} className="mt-1 w-full">
                {activeMode === 'ldap' ? <LogIn /> : <KeyRound />}
                Sign in
              </Button>
            </form>
          )}
        </div>
        {p?.version && p.version !== 'dev' && <p className="mt-4 text-center text-[11px] text-subtle">v{p.version}</p>}
      </div>
    </div>
  )
}
