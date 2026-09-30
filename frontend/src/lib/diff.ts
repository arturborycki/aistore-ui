export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; a?: number; b?: number }

/**
 * Line-level diff. The common prefix and suffix are matched directly and an
 * LCS is computed only for the middle; very large middles fall back to a
 * block replacement so memory stays bounded.
 */
export function diffLines(before: string, after: string, maxCells = 4_000_000): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const out: DiffLine[] = []
  for (let k = 0; k < pre; k++) out.push({ kind: 'same', text: a[k], a: k + 1, b: k + 1 })
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  const n = am.length
  const m = bm.length
  if (n * m > maxCells) {
    am.forEach((t, k) => out.push({ kind: 'del', text: t, a: pre + k + 1 }))
    bm.forEach((t, k) => out.push({ kind: 'add', text: t, b: pre + k + 1 }))
  } else {
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) out.push({ kind: 'same', text: am[i++], a: pre + i, b: pre + ++j })
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: am[i++], a: pre + i })
      else out.push({ kind: 'add', text: bm[j++], b: pre + j })
    }
    while (i < n) out.push({ kind: 'del', text: am[i++], a: pre + i })
    while (j < m) out.push({ kind: 'add', text: bm[j++], b: pre + j })
  }
  for (let k = suf; k > 0; k--) out.push({ kind: 'same', text: a[a.length - k], a: a.length - k + 1, b: b.length - k + 1 })
  return out
}

/** Collapses long unchanged runs, keeping `context` lines around changes. */
export function foldDiff(lines: DiffLine[], context = 3): (DiffLine | { kind: 'fold'; count: number })[] {
  const keep = lines.map(() => false)
  lines.forEach((l, i) => {
    if (l.kind !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const out: (DiffLine | { kind: 'fold'; count: number })[] = []
  let skipped = 0
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'fold', count: skipped })
      skipped = 0
      out.push(l)
    } else skipped++
  })
  if (skipped) out.push({ kind: 'fold', count: skipped })
  return out
}
