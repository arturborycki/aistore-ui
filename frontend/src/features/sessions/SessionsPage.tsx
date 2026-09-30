import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LaptopMinimal, LogOut, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import { useMe } from '@/auth/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Card, CardHeader, PageHeader } from '@/components/ui/layout'
import { EmptyState, ErrorState, InlineError } from '@/components/ui/states'
import { useToast } from '@/components/ui/toast'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'
import { sessionsApi, type SessionInfo } from '@/lib/session'

/** A readable "Browser on OS" label from a User-Agent string. */
export function describeAgent(ua?: string): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown device', mobile: false }
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|python|Go-http/i.test(ua) ? 'API client' : 'Browser'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Mobile|iPhone|Android/.test(ua) }
}

function Device({ s }: { s: SessionInfo }) {
  const d = describeAgent(s.userAgent)
  return (
    <span className="flex items-center gap-2">
      {d.mobile ? <Smartphone className="size-4 text-muted" /> : <LaptopMinimal className="size-4 text-muted" />}
      <span className="flex flex-col">
        <span className="font-medium" title={s.userAgent}>
          {d.label}
        </span>
        <span className="font-mono text-[11px] text-subtle">{s.clientIp ?? '—'}</span>
      </span>
      {s.current && <Badge tone="accent">This device</Badge>}
    </span>
  )
}

const when = (t: string) => (
  <Tooltip content={formatDateTime(t)}>
    <span className="text-muted">{formatRelative(t)}</span>
  </Tooltip>
)

export function SessionsPage() {
  const me = useMe()
  const qc = useQueryClient()
  const toast = useToast()
  const mine = useQuery({ queryKey: ['sessions', 'me'], queryFn: sessionsApi.mine })
  const all = useQuery({ queryKey: ['sessions', 'all'], queryFn: sessionsApi.all, enabled: me.user.admin })
  const [target, setTarget] = useState<{ s: SessionInfo; admin: boolean } | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['sessions'] })
  const revoke = useMutation({
    mutationFn: async ({ s, admin }: { s: SessionInfo; admin: boolean }) => (admin ? sessionsApi.adminRevoke(s.user.sub, s.handle) : sessionsApi.revoke(s.handle)),
    onSuccess: (_, { s }) => {
      setTarget(null)
      if (s.current) {
        // The server already ended this session and cleared its cookie.
        window.location.assign('/login')
        return
      }
      toast.success(`Signed out ${s.user.username} on ${describeAgent(s.userAgent).label}`)
      void refresh()
    },
  })
  const others = useMutation({
    mutationFn: sessionsApi.revokeOthers,
    onSuccess: (n) => {
      toast.success(n ? `Signed out ${n} other session${n === 1 ? '' : 's'}` : 'No other sessions')
      void refresh()
    },
  })

  const cols = (admin: boolean): Column<SessionInfo>[] => [
    ...(admin ? [{ key: 'user', header: 'User', cell: (s: SessionInfo) => <span className="font-medium">{s.user.username}</span> }] : []),
    { key: 'device', header: 'Device', cell: (s) => <Device s={s} /> },
    { key: 'method', header: 'Sign-in', cell: (s) => <Badge>{{ oidc: 'SSO', ldap: 'LDAP', builtin: 'Access key' }[s.user.method]}</Badge> },
    { key: 'created', header: 'Signed in', cell: (s) => when(s.createdAt) },
    { key: 'seen', header: 'Last active', cell: (s) => when(s.lastSeen) },
    { key: 'expires', header: 'Ends at the latest', cell: (s) => <span className="text-muted">{formatDateTime(s.expiresAt)}</span> },
    {
      key: 'actions',
      header: '',
      width: '110px',
      cell: (s) => (
        <Button size="sm" variant="danger-outline" onClick={() => setTarget({ s, admin })} aria-label={`Sign out ${s.user.username} on ${describeAgent(s.userAgent).label}${s.current ? ' (this device)' : ''}`}>
          <LogOut /> {s.current ? 'Sign out' : 'Revoke'}
        </Button>
      ),
    },
  ]

  const otherCount = (mine.data ?? []).filter((s) => !s.current).length

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Sessions"
        subtitle="Where you are signed in. Revoking a session signs that device out immediately and discards its AIStor credentials."
        actions={
          <>
            <Button variant="outline" onClick={() => refresh()}>
              <RefreshCw className={cn((mine.isFetching || all.isFetching) && 'animate-spin')} /> Refresh
            </Button>
            <Button variant="danger-outline" disabled={otherCount === 0} loading={others.isPending} onClick={() => others.mutate()}>
              <LogOut /> Sign out other sessions
            </Button>
          </>
        }
      />
      {others.isError && <InlineError error={others.error} />}
      <Card>
        <CardHeader title="Your sessions" description={mine.data ? `${mine.data.length} active` : undefined} />
        {mine.isError ? (
          <ErrorState error={mine.error} onRetry={() => mine.refetch()} className="m-3" />
        ) : (
          <DataTable columns={cols(false)} rows={mine.data ?? []} rowKey={(s) => s.handle} loading={mine.isPending} empty={<EmptyState title="No sessions" className="m-3 border-0" />} />
        )}
      </Card>
      {me.user.admin && (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="size-4 text-accent-text" /> All users
              </span>
            }
            description="Visible to catalog administrators. Use it to sign out a lost device or a departed user."
          />
          {all.isError ? (
            <ErrorState error={all.error} onRetry={() => all.refetch()} className="m-3" />
          ) : (
            <DataTable columns={cols(true)} rows={all.data ?? []} rowKey={(s) => `${s.user.sub}/${s.handle}`} loading={all.isPending} empty={<EmptyState title="No sessions" className="m-3 border-0" />} />
          )}
        </Card>
      )}
      <Dialog open={target != null} onOpenChange={(v) => !v && setTarget(null)}>
        {target && (
          <DialogContent title={target.s.current ? 'Sign out of this device?' : 'Revoke session?'} description={`${target.s.user.username} · ${describeAgent(target.s.userAgent).label} · ${target.s.clientIp ?? ''}`}>
            <DialogBody>
              <p className="text-[13px] text-muted">
                {target.s.current
                  ? 'You will be signed out here and returned to the sign-in page.'
                  : 'That device is signed out on its next request. Changes it has staged but not applied are lost.'}
              </p>
              <InlineError error={revoke.error} />
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setTarget(null)}>
                Cancel
              </Button>
              <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(target)}>
                <LogOut /> {target.s.current ? 'Sign out' : 'Revoke'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
