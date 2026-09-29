import { cn } from '@/lib/cn'

const KEYWORDS = new Set(
  'select from where group by order having limit offset join left right full inner outer cross on as and or not in is null like between case when then else end with union all distinct over partition window asc desc insert into values update set delete create view table if exists cast interval true false'.split(' '),
)

type Tok = { t: 'kw' | 'str' | 'num' | 'com' | 'fn' | 'id' | 'ws' | 'op'; v: string }

export function tokenizeSql(sql: string): Tok[] {
  const out: Tok[] = []
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*"|`[^`]*`)|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    if (m[1]) out.push({ t: 'com', v: m[1] })
    else if (m[2]) out.push({ t: 'str', v: m[2] })
    else if (m[3]) out.push({ t: 'id', v: m[3] })
    else if (m[4]) out.push({ t: 'num', v: m[4] })
    else if (m[5]) {
      const next = sql.slice(re.lastIndex).trimStart()[0]
      out.push({ t: KEYWORDS.has(m[5].toLowerCase()) ? 'kw' : next === '(' ? 'fn' : 'id', v: m[5] })
    } else if (m[6]) out.push({ t: 'ws', v: m[6] })
    else out.push({ t: 'op', v: m[7] })
  }
  return out
}

const cls: Record<Tok['t'], string> = {
  kw: 'text-[#7c3aed] dark:text-[#c4b5fd] font-medium',
  str: 'text-[#0d9488] dark:text-[#5eead4]',
  num: 'text-accent-text',
  com: 'text-subtle italic',
  fn: 'text-[#c2410c] dark:text-[#fdba74]',
  id: 'text-fg',
  ws: '',
  op: 'text-muted',
}

/** Read-only SQL with syntax highlighting and line numbers (text nodes only). */
export function SqlView({ sql, className }: { sql: string; className?: string }) {
  const lines: Tok[][] = [[]]
  for (const tok of tokenizeSql(sql)) {
    const parts = tok.v.split('\n')
    parts.forEach((p, i) => {
      if (i > 0) lines.push([])
      if (p) lines[lines.length - 1].push({ ...tok, v: p })
    })
  }
  return (
    <pre className={cn('overflow-auto py-3 font-mono text-[12.5px] leading-6', className)}>
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-10 shrink-0 select-none pr-3 text-right text-subtle">{i + 1}</span>
          <code className="whitespace-pre">
            {line.map((t, j) => (
              <span key={j} className={cls[t.t]}>
                {t.v}
              </span>
            ))}
          </code>
        </div>
      ))}
    </pre>
  )
}
