export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; a?: number; b?: number }

/** Line-level LCS diff (inputs are small: SQL view definitions). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ kind: 'same', text: a[i], a: ++i, b: ++j })
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: a[i], a: ++i })
    else out.push({ kind: 'add', text: b[j], b: ++j })
  }
  while (i < n) out.push({ kind: 'del', text: a[i], a: ++i })
  while (j < m) out.push({ kind: 'add', text: b[j], b: ++j })
  return out
}
