import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { ExternalLink, ShieldCheck } from 'lucide-react'
import { registerStepUpHandler, type ReauthReason } from '@/lib/api'
import { sessionApi } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { InlineError } from '@/components/ui/states'
import { useAuth } from './AuthContext'

/**
 * Handles StepUpRequired responses: asks the user to prove their identity
 * again, then lets the API client retry the original request.
 *  - LDAP / access-key sessions re-enter their password.
 *  - SSO sessions re-authenticate at the identity provider in a popup
 *    (prompt=login); if popups are blocked we fall back to a full redirect.
 * It also renews expired AIStor credentials of password sessions in place
 * (CredentialsExpired), so the user keeps their page and unsaved work.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { me, setMe } = useAuth()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ReauthReason>('step-up')
  const [secret, setSecret] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const finish = useCallback((ok: boolean) => {
    resolver.current?.(ok)
    resolver.current = null
    setOpen(false)
    setSecret('')
    setError(null)
    setPending(false)
  }, [])

  useEffect(() => {
    registerStepUpHandler(
      (why) =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false)
          resolver.current = resolve
          setReason(why)
          setOpen(true)
        }),
    )
    return () => registerStepUpHandler(null)
  }, [])

  const method = me?.user.method

  const confirmPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      setMe(await sessionApi.stepUp(secret))
      finish(true)
    } catch (err) {
      setError(err)
      setPending(false)
    }
  }

  const confirmSSO = () => {
    const url = `/auth/oidc/login?stepUp=1&returnTo=${encodeURIComponent('/step-up-complete')}`
    const popup = window.open(url, 'aistor-stepup', 'popup,width=520,height=680')
    if (!popup) {
      // Popups blocked: re-authenticate in this tab and come back here.
      window.location.assign(`/auth/oidc/login?stepUp=1&returnTo=${encodeURIComponent(location.pathname + location.search)}`)
      return
    }
    setPending(true)
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin || ev.data?.type !== 'aistor-stepup') return
      window.removeEventListener('message', onMessage)
      window.clearInterval(timer)
      if (ev.data.ok) finish(true)
      else {
        setPending(false)
        setError(new Error('Identity confirmation failed.'))
      }
    }
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer)
        window.removeEventListener('message', onMessage)
        setPending(false)
      }
    }, 500)
    window.addEventListener('message', onMessage)
  }

  return (
    <>
      {children}
      <Dialog open={open} onOpenChange={(v) => !v && finish(false)}>
        <DialogContent
          title={reason === 'credentials' ? 'Sign in again' : "Confirm it's you"}
          description={
            reason === 'credentials'
              ? 'Your AIStor credentials expired. Enter your password to renew them; you stay on this page and nothing is lost.'
              : 'This action is sensitive. Confirm your identity to continue.'
          }
        >
          {method === 'oidc' ? (
            <>
              <DialogBody>
                <p className="text-[13px] text-muted">A window will open where your identity provider asks you to sign in again.</p>
                <InlineError error={error} />
              </DialogBody>
              <DialogFooter>
                <Button variant="ghost" onClick={() => finish(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={confirmSSO} loading={pending}>
                  <ExternalLink />
                  Confirm identity
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={confirmPassword}>
              <DialogBody>
                <Field label={method === 'builtin' ? `Secret key for ${me?.user.username}` : `Password for ${me?.user.username}`}>
                  {(p) => (
                    <Input {...p} type="password" autoComplete="current-password" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus required />
                  )}
                </Field>
                <InlineError error={error} />
              </DialogBody>
              <DialogFooter>
                <Button variant="ghost" onClick={() => finish(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" loading={pending}>
                  <ShieldCheck />
                  {reason === 'credentials' ? 'Continue' : 'Confirm'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Landing page for the SSO step-up popup. */
export function StepUpComplete() {
  useEffect(() => {
    if (window.opener) {
      window.opener.postMessage({ type: 'aistor-stepup', ok: true }, window.location.origin)
      window.close()
    } else {
      window.location.replace('/')
    }
  }, [])
  return <p className="p-8 text-center text-muted">Identity confirmed. You can close this window.</p>
}
