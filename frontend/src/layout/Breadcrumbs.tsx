import { Fragment, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { ChevronRight } from 'lucide-react'
import { decodeNamespaceParam } from '@/lib/namespace'
import { EntityIcon } from '@/components/ui/entity-icon'
import { paths } from './paths'

export function Breadcrumbs({ cluster }: { cluster: string }) {
  const { wh, ns, table, view, model } = useParams()
  const location = useLocation()
  const levels = decodeNamespaceParam(ns)
  const crumbs: { to: string; label: ReactNode }[] = []

  if (location.pathname.endsWith('/activity')) crumbs.push({ to: paths.activity(cluster), label: 'Activity' })
  else if (location.pathname.endsWith('/sessions')) crumbs.push({ to: paths.sessions(cluster), label: 'Sessions' })
  else if (location.pathname.endsWith('/warehouses') || wh) crumbs.push({ to: paths.warehouses(cluster), label: 'Warehouses' })
  else crumbs.push({ to: paths.overview(cluster), label: 'Overview' })

  if (wh) {
    crumbs.push({
      to: paths.warehouse(cluster, wh),
      label: (
        <span className="flex items-center gap-1.5">
          <EntityIcon kind="warehouse" className="size-3.5" />
          {wh}
        </span>
      ),
    })
    levels.forEach((level, i) =>
      crumbs.push({
        to: paths.namespace(cluster, wh, levels.slice(0, i + 1)),
        label: (
          <span className="flex items-center gap-1.5">
            <EntityIcon kind="namespace" className="size-3.5" />
            {level}
          </span>
        ),
      }),
    )
    if (model) {
      crumbs.push({
        to: paths.model(cluster, wh, levels, model),
        label: (
          <span className="flex items-center gap-1.5">
            <EntityIcon kind="model" className="size-3.5" />
            {model}
          </span>
        ),
      })
    }
    if (table || view) {
      const kind = table ? 'table' : 'view'
      const name = (table ?? view)!
      crumbs.push({
        to: table ? paths.table(cluster, wh, levels, name) : paths.view(cluster, wh, levels, name),
        label: (
          <span className="flex items-center gap-1.5">
            <EntityIcon kind={kind} className="size-3.5" />
            {name}
          </span>
        ),
      })
    }
  }

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-[13px]">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <Fragment key={i}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-subtle" aria-hidden />}
              <li className="min-w-0">
                {last ? (
                  <span aria-current="page" className="block truncate font-medium text-fg">
                    {c.label}
                  </span>
                ) : (
                  <Link to={c.to} className="block truncate text-muted hover:text-fg">
                    {c.label}
                  </Link>
                )}
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
