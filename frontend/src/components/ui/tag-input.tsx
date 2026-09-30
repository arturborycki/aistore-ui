import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

/** A list of short strings edited as removable chips (Enter or comma adds). */
export function TagInput({
  value,
  onChange,
  label,
  placeholder = 'Add…',
  className,
  disabled,
}: {
  value: string[]
  onChange: (v: string[]) => void
  label: string
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const next = [...value]
    for (const it of items) if (!next.some((v) => v.toLowerCase() === it.toLowerCase())) next.push(it)
    if (next.length !== value.length) onChange(next)
    setDraft('')
  }
  return (
    <div
      className={cn(
        'flex min-h-8 flex-wrap items-center gap-1 rounded-[var(--radius-control)] border border-border bg-bg px-1.5 py-1 focus-within:border-accent',
        disabled && 'opacity-60',
        className,
      )}
    >
      {value.map((v, i) => (
        <span key={`${v}-${i}`} className="inline-flex h-6 items-center gap-1 rounded-[4px] bg-surface px-1.5 text-[12px]">
          {v}
          {!disabled && (
            <button type="button" aria-label={`Remove ${v}`} className="rounded text-muted hover:text-fg" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          aria-label={label}
          value={draft}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(draft)
            } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={() => draft.trim() && add(draft)}
          className="h-6 min-w-[90px] flex-1 bg-transparent px-1 text-[12.5px] outline-none placeholder:text-subtle"
        />
      )}
    </div>
  )
}
