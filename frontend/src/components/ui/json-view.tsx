import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function Primitive({ v }: { v: Json }) {
  if (v === null) return <span className="text-subtle">null</span>
  if (typeof v === 'boolean') return <span className="text-[#c2410c] dark:text-[#fdba74]">{String(v)}</span>
  if (typeof v === 'number') return <span className="text-accent-text">{v}</span>
  // digit-only strings are exact 64-bit integers preserved by the parser
  if (typeof v === 'string' && /^-?\d{16,}$/.test(v)) return <span className="text-accent-text">{v}</span>
  return <span className="break-all text-[#0d9488] dark:text-[#5eead4]">&quot;{String(v)}&quot;</span>
}

function Node({ name, value, depth, defaultDepth }: { name?: ReactNode; value: Json; depth: number; defaultDepth: number }) {
  const isObj = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < defaultDepth)
  const key = name != null && <span className="text-fg">{name}: </span>
  if (!isObj) {
    return (
      <div className="pl-4">
        {key}
        <Primitive v={value} />
      </div>
    )
  }
  const entries: [string, Json][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value)
  const [lb, rb] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  return (
    <div className={cn(depth > 0 && 'pl-4')}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="-ml-4 inline-flex items-center gap-0 text-left hover:text-accent-text">
        <ChevronRight className={cn('size-3.5 text-subtle transition-transform', open && 'rotate-90')} />
        {key}
        <span className="text-subtle">{lb}</span>
        {!open && (
          <span className="text-subtle">
            {' '}
            {entries.length} {Array.isArray(value) ? 'items' : 'keys'} {rb}
          </span>
        )}
      </button>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <Node key={k} name={Array.isArray(value) ? <span className="text-subtle">{k}</span> : `"${k}"`} value={v} depth={depth + 1} defaultDepth={defaultDepth} />
          ))}
          <div className="text-subtle">{rb}</div>
        </>
      )}
    </div>
  )
}

/** Collapsible JSON tree. Values are rendered as text nodes only. */
export function JsonView({ value, defaultDepth = 2, className }: { value: unknown; defaultDepth?: number; className?: string }) {
  return (
    <div className={cn('pl-4 font-mono text-[12px] leading-5', className)}>
      <Node value={value as Json} depth={0} defaultDepth={defaultDepth} />
    </div>
  )
}
