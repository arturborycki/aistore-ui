import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Clock, KeyRound, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { lastActivityAt, reauthenticate } from '@/lib/api'
import { sessionApi } from '@/lib/session'
import { useAuth } from './AuthContext'

const IDLE_WARN_MS = 2 * 60_000
const ABSOLUTE_WARN_MS = 5 * 60_000
const CREDS_WARN_MS = 2 * 60_000

function countdown(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

type Warning = { kind: 'idle' | 'absolute' | 'credentials'; remaining: number }

/**
 * Warns before the session ends (inactivity or maximum length) and before the
 * AIStor credentials of a password session expire, offering the matching fix.
 */
export function SessionWarnings() {
  const { me, setMe, logout } = useAuth()
  const qc = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  let warning: Warning | null = null
  if (me) {
    // The server only records activity once a minute, so be conservative.
    const idleDeadline = Math.max(me.idleExpiresAt ? Date.parse(me.idleExpiresAt) : 0, lastActivityAt() - 60_000 + me.idleTimeoutSeconds * 1000)
    const absDeadline = Date.parse(me.expiresAt)
    const credDeadline = me.credentialsExpireAt ? Date.parse(me.credentialsExpireAt) : Infinity
    const idle = idleDeadline - now
    const abs = absDeadline - now
    const creds = credDeadline - now
    if (abs <= ABSOLUTE_WARN_MS && abs <= idle) warning = { kind: 'absolute', remaining: abs }
    else if (idle <= IDLE_WARN_MS) warning = { kind: 'idle', remaining: idle }
    else if (creds <= CREDS_WARN_MS) warning = { kind: 'credentials', remaining: creds }
    if (warning && dismissed === `${warning.kind}:${me.expiresAt}`) warning = null
  }

  // Tick fast only while a warning is visible.
  const urgent = warning != null
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), urgent ? 1000 : 15_000)
    return () => window.clearInterval(t)
  }, [urgent])

  // Once the session is over, let the auth layer notice and redirect to sign-in.
  const over = warning != null && warning.kind !== 'credentials' && warning.remaining <= 0
  useEffect(() => {
    if (over) void qc.invalidateQueries({ queryKey: ['me'] })
  }, [over, qc])

  if (!warning || !me) return null

  const act = async (f: () => Promise<void>) => {
    setBusy(true)
    try {
      await f()
    } finally {
      setBusy(false)
    }
  }

  const content = {
    idle: {
      icon: <Clock className="size-4" />,
      text: <>You will be signed out for inactivity in <span className="font-mono tabular">{countdown(warning.remaining)}</span>.</>,
      action: (
        <Button size="sm" variant="primary" loading={busy} onClick={() => act(async () => setMe(await sessionApi.me(false)))}>
          Stay signed in
        </Button>
      ),
    },
    absolute: {
      icon: <LogIn className="size-4" />,
      text: <>Your session reaches its maximum length in <span className="font-mono tabular">{countdown(warning.remaining)}</span>. Finish or stage your work, then sign in again.</>,
      action: (
        <>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(`absolute:${me.expiresAt}`)}>
            Dismiss
          </Button>
          <Button size="sm" variant="outline" onClick={() => void logout()}>
            Sign in again
          </Button>
        </>
      ),
    },
    credentials: {
      icon: <KeyRound className="size-4" />,
      text:
        warning.remaining > 0 ? (
          <>Your AIStor credentials expire in <span className="font-mono tabular">{countdown(warning.remaining)}</span>.</>
        ) : (
          <>Your AIStor credentials have expired.</>
        ),
      action: (
        <Button size="sm" variant="primary" loading={busy} onClick={() => act(async () => void (await reauthenticate('credentials')))}>
          Renew
        </Button>
      ),
    },
  }[warning.kind]

  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 flex w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-warning/50 bg-bg px-4 py-3 text-[13px] shadow-lg"
    >
      <span className="text-warning">{content.icon}</span>
      <span className="min-w-0 flex-1">{content.text}</span>
      <span className="flex gap-2">{content.action}</span>
    </div>
  )
}
