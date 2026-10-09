import type { Ledger, Snapshot } from '../types'

const DAY = 86400 * 1000

export const ago = (iso: string | null, now: number): string => {
  if (!iso) return '—'
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`
  if (s < 86400 * 730) return `${Math.round(s / (86400 * 30))}mo`
  return `${Math.round(s / (86400 * 365))}y`
}

export const compact = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)

/** The last `days` UTC dates ending at `now`, oldest first, as YYYY-MM-DD. */
export const dayKeys = (now: number, days = 14): string[] =>
  Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10))

/** GitHub's traffic rows mapped onto fixed days, zero where a day is missing. */
export const perDay = (rows: { timestamp: string; count: number }[], keys: string[]): number[] => {
  const byDay = new Map(rows.map(r => [r.timestamp.slice(0, 10), r.count]))
  return keys.map(k => byDay.get(k) ?? 0)
}

/** "2026-04-14" as "Apr 14", with the year when it isn't this year's. */
export const shortDate = (day: string, now: number): string => {
  const d = new Date(`${day}T00:00:00Z`)
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const year = d.getUTCFullYear() === new Date(now).getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`
  return `${month} ${d.getUTCDate()}${year}`
}

export const repoKey = (owner: string, name: string) => `${owner}/${name}`

export function toLedger(snap: Snapshot): Ledger {
  const repos: Ledger['repos'] = {}
  for (const r of snap.accounts.flatMap(a => a.repos)) {
    repos[repoKey(r.owner, r.name)] = { stars: r.stars, forks: r.forks, issues: r.issues, release: r.release }
  }
  return { at: snap.fetchedAt, repos }
}

export type Change = { kind: 'star' | 'fork' | 'issue' | 'release'; repo: string; amount: number; tag?: string }

/** What grew between an earlier ledger and a newer snapshot. Repos new to the ledger are not news. */
export function changes(before: Ledger, after: Snapshot): Change[] {
  const out: Change[] = []
  for (const r of after.accounts.flatMap(a => a.repos)) {
    const was = before.repos[repoKey(r.owner, r.name)]
    if (!was) continue
    if (r.stars > was.stars) out.push({ kind: 'star', repo: r.name, amount: r.stars - was.stars })
    if (r.forks > was.forks) out.push({ kind: 'fork', repo: r.name, amount: r.forks - was.forks })
    if (r.issues > was.issues) out.push({ kind: 'issue', repo: r.name, amount: r.issues - was.issues })
    if (r.release && r.release !== was.release) out.push({ kind: 'release', repo: r.name, amount: 1, tag: r.release })
  }
  return out
}

export function describe(c: Change): string {
  switch (c.kind) {
    case 'star':
      return `⭐ +${c.amount} star${c.amount === 1 ? '' : 's'} on ${c.repo}`
    case 'fork':
      return `🍴 ${c.repo} was forked${c.amount > 1 ? ` ${c.amount}×` : ''}`
    case 'issue':
      return `🐛 ${c.amount} new issue${c.amount === 1 ? '' : 's'} on ${c.repo}`
    case 'release':
      return `🚀 ${c.repo} shipped ${c.tag}`
  }
}

/** One line summing a batch of changes, for the digest. */
export function summarize(list: Change[], clones: number): string {
  const sum = (k: Change['kind']) => list.filter(c => c.kind === k).reduce((n, c) => n + c.amount, 0)
  const parts = [
    sum('star') && `+${sum('star')} ⭐`,
    sum('fork') && `+${sum('fork')} 🍴`,
    sum('issue') && `${sum('issue')} new issue${sum('issue') === 1 ? '' : 's'}`,
    sum('release') && `${sum('release')} release${sum('release') === 1 ? '' : 's'} 🚀`,
    clones && `${compact(clones)} clones`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'all quiet'
}

/** An asset name with its version numbers swapped for a placeholder, so releases compare. */
export const assetShape = (name: string): string =>
  name.replace(/v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|pre)[.\d]*)?/gi, '{v}')

/** Assets the previous release had that the latest lacks, by shape. */
export function missingAssets(latest: string[], previous: string[]): string[] {
  const have = new Set(latest.map(assetShape))
  return previous.filter(n => !have.has(assetShape(n)))
}


export type DayRow = { timestamp: string; count: number }

/** Daily traffic per repo, kept across sessions; zero days are not stored. */
export type History = Record<string, { clones: Record<string, number>; views: Record<string, number> }>

/** Folds GitHub's daily rows into a repo's days. A day only ever grows, so keep the larger count. */
export function record(days: Record<string, number>, rows: DayRow[]): void {
  for (const row of rows) {
    const day = row.timestamp.slice(0, 10)
    if (row.count > 0) days[day] = Math.max(days[day] ?? 0, row.count)
  }
}

const total = (days: Record<string, number>) => Object.values(days).reduce((n, c) => n + c, 0)

/** A repo's lifetime totals and the first day on record. */
export function lifetime(entry: History[string] | undefined): { clones: number; views: number; since: string | null } {
  if (!entry) return { clones: 0, views: 0, since: null }
  const days = [...Object.keys(entry.clones), ...Object.keys(entry.views)].sort()
  return { clones: total(entry.clones), views: total(entry.views), since: days[0] ?? null }
}

/**
 * Merges a clone tracker's export into the history:
 * `{ by_repo: { "owner/name": { days: { "YYYY-MM-DD": count } } } }`.
 */
export function importTracker(history: History, data: unknown): { repos: number; days: number } {
  const byRepo = (data as { by_repo?: Record<string, { days?: Record<string, number> }> })?.by_repo
  if (!byRepo || typeof byRepo !== 'object') throw new Error('expected a JSON object with a "by_repo" field')
  let repos = 0
  let days = 0
  for (const [key, entry] of Object.entries(byRepo)) {
    const rows = Object.entries(entry?.days ?? {}).map(([timestamp, count]) => ({ timestamp, count: Number(count) || 0 }))
    if (rows.length === 0) continue
    const target = (history[key] ??= { clones: {}, views: {} })
    record(target.clones, rows)
    repos += 1
    days += rows.length
  }
  return { repos, days }
}

/** Folds `from` into `into`, day by day, keeping the larger count; either side may hold days the other lacks. */
export function mergeHistory(into: History, from: History | undefined): History {
  for (const [key, entry] of Object.entries(from ?? {})) {
    const target = (into[key] ??= { clones: {}, views: {} })
    for (const kind of ['clones', 'views'] as const) {
      for (const [day, n] of Object.entries(entry?.[kind] ?? {})) target[kind][day] = Math.max(target[kind][day] ?? 0, n)
    }
  }
  return into
}
