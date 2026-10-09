// Pure helpers, ported from mod/hooks/lib.ts. Keep the two in step.
const DAY = 86400 * 1000

const ago = (iso, now) => {
  if (!iso) return '—'
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`
  if (s < 86400 * 730) return `${Math.round(s / (86400 * 30))}mo`
  return `${Math.round(s / (86400 * 365))}y`
}

const compact = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

/** The last `days` UTC dates ending at `now`, oldest first, as YYYY-MM-DD. */
const dayKeys = (now, days = 14) =>
  Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10))

const repoKey = (owner, name) => `${owner}/${name}`

function toLedger(snap) {
  const repos = {}
  for (const r of snap.accounts.flatMap(a => a.repos)) {
    repos[repoKey(r.owner, r.name)] = { stars: r.stars, forks: r.forks, issues: r.issues, release: r.release }
  }
  return { at: snap.fetchedAt, repos }
}

/** What grew between an earlier ledger and a newer snapshot. Repos new to the ledger are not news. */
function changes(before, after) {
  const out = []
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

function describe(c) {
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
function summarize(list, clones) {
  const sum = k => list.filter(c => c.kind === k).reduce((n, c) => n + c.amount, 0)
  const parts = [
    sum('star') && `+${sum('star')} ⭐`,
    sum('fork') && `+${sum('fork')} 🍴`,
    sum('issue') && `${sum('issue')} new issue${sum('issue') === 1 ? '' : 's'}`,
    sum('release') && `${sum('release')} release${sum('release') === 1 ? '' : 's'} 🚀`,
    clones && `${compact(clones)} clones`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'all quiet'
}

/** Folds GitHub's daily rows into a repo's days. A day only ever grows, so keep the larger count. */
function record(days, rows) {
  for (const row of rows) {
    const day = row.timestamp.slice(0, 10)
    if (row.count > 0) days[day] = Math.max(days[day] ?? 0, row.count)
  }
}

const total = days => Object.values(days).reduce((n, c) => n + c, 0)

/** A repo's lifetime totals and the first day on record. */
function lifetime(entry) {
  if (!entry) return { clones: 0, views: 0, since: null }
  const days = [...Object.keys(entry.clones), ...Object.keys(entry.views)].sort()
  return { clones: total(entry.clones), views: total(entry.views), since: days[0] ?? null }
}

/** An asset name with its version numbers swapped for a placeholder, so releases compare. */
const assetShape = name => name.replace(/v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|pre)[.\d]*)?/gi, '{v}')

/** Assets the previous release had that the latest lacks, by shape. */
function missingAssets(latest, previous) {
  const have = new Set(latest.map(assetShape))
  return previous.filter(n => !have.has(assetShape(n)))
}

module.exports = { missingAssets, ago, compact, dayKeys, repoKey, toLedger, changes, describe, summarize, record, lifetime }

/** Folds `from` into `into`, day by day, keeping the larger count; either side may hold days the other lacks. */
function mergeHistory(into, from) {
  for (const [key, entry] of Object.entries(from ?? {})) {
    const target = (into[key] ??= { clones: {}, views: {} })
    for (const kind of ['clones', 'views']) {
      for (const [day, n] of Object.entries(entry?.[kind] ?? {})) target[kind][day] = Math.max(target[kind][day] ?? 0, n)
    }
  }
  return into
}
module.exports.mergeHistory = mergeHistory
