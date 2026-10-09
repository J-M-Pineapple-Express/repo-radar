import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Account, Health, Ledger, Repo, Snapshot, Status, Traffic } from '../types'
import { ago, changes, compact, dayKeys, describe, importTracker, lifetime, mergeHistory, shortDate, missingAssets, perDay, record, repoKey, summarize, toLedger } from './lib'
import type { DayRow, History } from './lib'

const PANE = 'repo-radar'
const REFRESH_MS = 10 * 60 * 1000
const TICK_MS = 8 * 1000
const PAGE_LIMIT = 5
const PREVIEW = 8
const STALE_DAYS = 90
const TRAFFIC_MS = 60 * 60 * 1000 // GitHub updates traffic about hourly
const TRAFFIC_LIMIT = 300 // per account, most recently pushed first: in practice every repo
const TRAFFIC_BATCH = 10 // repos fetched at once
const AWAY_MS = 30 * 60 * 1000
const TOAST_LIMIT = 3

const snapshot = atom({ plugin: 'repo-radar', key: 'snapshot' } as const, null)
const status = atom({ plugin: 'repo-radar', key: 'status' } as const, 'idle')
const message = atom({ plugin: 'repo-radar', key: 'message' } as const, '')
const expanded = atom({ plugin: 'repo-radar', key: 'expanded' } as const, [])
const digest = atom({ plugin: 'repo-radar', key: 'digest' } as const, '')
const hiddenColumns = atom({ plugin: 'repo-radar', key: 'hidden' } as const, [])

const DOT: Record<Health, { glyph: string; color: string }> = {
  green: { glyph: '●', color: 'green' },
  yellow: { glyph: '●', color: 'yellow' },
  red: { glyph: '●', color: 'red' },
  archived: { glyph: '○', color: 'gray' },
}

const QUERY = `query($after: String) {
  viewer {
    login
    repositories(first: 100, after: $after,
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
      orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name url isPrivate isFork isArchived pushedAt viewerPermission
        owner { login }
        stargazerCount forkCount
        issues(states: OPEN) { totalCount }
        pullRequests(states: OPEN) { totalCount }
        latestRelease { tagName }
        primaryLanguage { name color }
        defaultBranchRef { target { ... on Commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

type Login = { host: string; login: string; token: string }
type Engine = EngineInterface

const graphqlUrl = (host: string) =>
  host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`

const restBase = (host: string) => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)

const restHeaders = (token: string) => ({
  Authorization: `bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'repo-radar',
})

const winPath = (path: string) => path.replaceAll('/', '\\')

/** The file the widget shares: ~/.claude/repo-radar/data.json. */
async function sharedPath($: Engine): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home}/.claude/repo-radar/data.json` : null
}

type Shared = { history?: History; ledger?: Ledger | null; watchedSince?: string | null; prefs?: Record<string, unknown> } & Record<string, unknown>

async function loadShared($: Engine): Promise<Shared | null> {
  const file = await sharedPath($)
  if (!file || !(await $.fs.exists(file))) return null
  // Both sides move their writes into place; a second read covers an unlucky moment anyway.
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(await $.fs.read(file)) as Shared
    } catch {
      await $.clock.sleep(200)
    }
  }
  return null
}

/** Merges our history, ledger and prefs into the shared file, leaving the widget's own fields alone. */
async function saveShared($: Engine, patch: { history?: History; ledger?: Ledger; watchedSince?: string; hiddenColumns?: string[] }): Promise<void> {
  const file = await sharedPath($)
  if (!file) return
  try {
    const data: Shared = (await loadShared($)) ?? { version: 1, accounts: [], fetchedAt: 0, trafficAt: 0 }
    if (patch.history) data.history = mergeHistory(data.history ?? {}, patch.history)
    if (patch.ledger && (!data.ledger || patch.ledger.at > data.ledger.at)) data.ledger = patch.ledger
    if (patch.watchedSince && (!data.watchedSince || patch.watchedSince < data.watchedSince)) data.watchedSince = patch.watchedSince
    if (patch.hiddenColumns) data.prefs = { ...data.prefs, hiddenColumns: patch.hiddenColumns }
    // Write beside it, then move into place, so the widget never reads half a file.
    const tmp = `${file}.mod.tmp`
    await $.fs.write(tmp, JSON.stringify(data))
    const isWindows = file.includes('\\') || /^[A-Za-z]:/.test(file)
    await $.process.run(isWindows ? ['cmd', '/c', 'move', '/y', winPath(tmp), winPath(file)] : ['mv', '-f', tmp, file])
  } catch {
    // the widget is a bonus; the mod's own store still has everything
  }
}

/**
 * Starts the widget without waiting on it. The installed app first; while building,
 * the widget folder beside this mod. `start` detaches it, so a mod reload never closes it.
 */
async function launchWidget($: Engine): Promise<string> {
  const local = (await $.env.get('LOCALAPPDATA')) ?? ''
  const root = $.plugin.root.replaceAll('\\', '/').replace(/\/$/, '').replace(/\/\.claude-plugin$/, '')
  const dev = `${root.slice(0, root.lastIndexOf('/'))}/widget`
  const installed = `${local}/Programs/Repo Radar/Repo Radar.exe`
  const devElectron = `${dev}/node_modules/electron/dist/electron.exe`
  const argv = local && (await $.fs.exists(installed))
    ? [installed]
    : (await $.fs.exists(devElectron))
      ? [devElectron, dev]
      : null
  if (!argv) return "Couldn't find the Repo Radar widget. Install it from the AfterRealm releases page, then try /repos widget again."
  const r = await $.process.run(['cmd', '/c', 'start', 'Repo Radar', ...argv.map(winPath)])
  return r.exitCode === 0 ? '📡 Repo Radar widget launched.' : `Couldn't launch the widget: ${r.stderr.trim() || `exit ${r.exitCode}`}`
}

async function ghLogins($: Engine): Promise<{ host: string; login: string }[]> {
  try {
    const json = await $.process.run(['gh', 'auth', 'status', '--json', 'hosts'])
    if (json.exitCode === 0) {
      const hosts = JSON.parse(json.stdout).hosts as Record<string, { state: string; host: string; login: string }[]>
      return Object.values(hosts)
        .flat()
        .filter(a => a.state === 'success')
        .map(a => ({ host: a.host, login: a.login }))
    }
    // Older gh: no --json on auth status, so read the human output.
    const text = await $.process.run(['gh', 'auth', 'status'])
    const out = `${text.stdout}\n${text.stderr}`
    return [...out.matchAll(/Logged in to (\S+) (?:account|as) ([\w-]+)/g)].map(m => ({ host: m[1]!, login: m[2]! }))
  } catch {
    return [] // gh not installed
  }
}

async function discover($: Engine, fallbackToken: string): Promise<Login[]> {
  const logins: Login[] = []
  for (const { host, login } of await ghLogins($)) {
    try {
      const r = await $.process.run(['gh', 'auth', 'token', '--hostname', host, '--user', login])
      if (r.exitCode === 0 && r.stdout.trim()) logins.push({ host, login, token: r.stdout.trim() })
    } catch {
      // skip an account whose token can't be read
    }
  }
  if (logins.length === 0 && fallbackToken) logins.push({ host: 'github.com', login: '', token: fallbackToken })
  return logins
}

function toRepo(node: any, now: number): Repo {
  const ci = node.defaultBranchRef?.target?.statusCheckRollup?.state
  const stale = node.pushedAt && now - Date.parse(node.pushedAt) > STALE_DAYS * 86400 * 1000
  const health: Health = node.isArchived
    ? 'archived'
    : ci === 'FAILURE' || ci === 'ERROR'
      ? 'red'
      : stale
        ? 'yellow'
        : 'green'
  return {
    name: node.name,
    owner: node.owner.login,
    url: node.url,
    isPrivate: node.isPrivate,
    isFork: node.isFork,
    stars: node.stargazerCount,
    forks: node.forkCount,
    issues: node.issues.totalCount,
    prs: node.pullRequests.totalCount,
    release: node.latestRelease?.tagName ?? null,
    pushedAt: node.pushedAt,
    language: node.primaryLanguage?.name ?? null,
    languageColor: node.primaryLanguage?.color ?? null,
    health,
    canPush: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(node.viewerPermission),
  }
}

async function fetchAccount($: Engine, who: Login, now: number): Promise<Account> {
  const repos: Repo[] = []
  let login = who.login
  let after: string | null = null
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const res = await $.http.fetch(graphqlUrl(who.host), {
      method: 'POST',
      headers: { Authorization: `bearer ${who.token}`, 'Content-Type': 'application/json', 'User-Agent': 'repo-radar' },
      body: JSON.stringify({ query: QUERY, variables: { after } }),
    })
    const body = JSON.parse(res.text)
    if (!res.ok || body.errors) {
      const why = body.errors?.[0]?.message ?? body.message ?? `HTTP ${res.status}`
      return { host: who.host, login: login || '?', repos, error: why }
    }
    const conn = body.data.viewer.repositories
    login = body.data.viewer.login
    repos.push(...conn.nodes.map((n: any) => toRepo(n, now)))
    if (!conn.pageInfo.hasNextPage) break
    after = conn.pageInfo.endCursor
  }
  return { host: who.host, login, repos }
}

function tickerLines(snap: Snapshot): string[] {
  const all = snap.accounts.flatMap(a => a.repos)
  const live = all.filter(r => r.health !== 'archived')
  const red = live.filter(r => r.health === 'red')
  const stars = all.reduce((n, r) => n + r.stars, 0)
  const forks = all.reduce((n, r) => n + r.forks, 0)
  const issues = live.reduce((n, r) => n + r.issues, 0)
  const prs = live.reduce((n, r) => n + r.prs, 0)
  const lines = [
    `${all.length} repos · ⭐ ${compact(stars)} · 🍴 ${compact(forks)}`,
    `🐛 ${issues} open issues · 🔀 ${prs} open PRs`,
  ]
  if (red.length) lines.push(`🔴 CI failing: ${red.slice(0, 3).map(r => r.name).join(', ')}${red.length > 3 ? '…' : ''}`)
  const top = [...all].sort((a, b) => b.stars - a.stars)[0]
  if (top && top.stars > 0) lines.push(`🏆 Top repo: ${top.name} (⭐ ${compact(top.stars)})`)
  return lines
}

async function fetchTraffic($: Engine, who: Login, r: Repo): Promise<{ clones: DayRow[]; views: DayRow[] } | undefined> {
  const base = `${restBase(who.host)}/repos/${r.owner}/${r.name}/traffic`
  const [c, v] = await Promise.all([
    $.http.fetch(`${base}/clones`, { headers: restHeaders(who.token) }),
    $.http.fetch(`${base}/views`, { headers: restHeaders(who.token) }),
  ])
  if (!c.ok || !v.ok) return undefined
  return { clones: JSON.parse(c.text).clones ?? [], views: JSON.parse(v.text).views ?? [] }
}

/**
 * Fetches the freshest 14 days for every repo we can push to and folds them into the lifetime history.
 * GitHub keeps only 14 days, so a repo skipped here loses days for good. Batched to stay polite.
 */
async function addTraffic($: Engine, who: Login, acct: Account, history: History): Promise<void> {
  const picks = acct.repos.filter(r => r.canPush && r.health !== 'archived').slice(0, TRAFFIC_LIMIT)
  for (let i = 0; i < picks.length; i += TRAFFIC_BATCH) {
    await Promise.all(
      picks.slice(i, i + TRAFFIC_BATCH).map(async r => {
        try {
          const rows = await fetchTraffic($, who, r)
          if (!rows) return
          const entry = (history[repoKey(r.owner, r.name)] ??= { clones: {}, views: {} })
          record(entry.clones, rows.clones)
          record(entry.views, rows.views)
        } catch {
          // traffic is a bonus; a failure leaves the row without it
        }
      }),
    )
  }
}

/** Gives every repo with history its lifetime totals and recent clone days. */
function withLifetime(snap: Snapshot, history: History): Snapshot {
  const keys = dayKeys(snap.fetchedAt)
  const accounts = snap.accounts.map(a => ({
    ...a,
    repos: a.repos.map(r => {
      const entry = history[repoKey(r.owner, r.name)]
      if (!entry) return r
      const life = lifetime(entry)
      const recent = Object.entries(entry.clones).map(([timestamp, count]) => ({ timestamp, count }))
      const traffic: Traffic = { clones: perDay(recent, keys), clonesLifetime: life.clones, viewsLifetime: life.views, since: life.since }
      return { ...r, traffic }
    }),
  }))
  return { ...snap, accounts }
}

async function importHistory($: Engine, fallbackToken: string, source: string): Promise<string> {
  const src = source.trim()
  if (!src) {
    return [
      'Usage: /repos-import <file>  or  /repos-import <owner/repo>:<path>',
      'The file is JSON: { "by_repo": { "owner/name": { "days": { "YYYY-MM-DD": clones } } } }',
    ].join('\n')
  }
  let text: string
  const remote = /^([\w.-]+\/[\w.-]+):(.+)$/.exec(src)
  if (remote) {
    const logins = await discover($, fallbackToken)
    const who = logins.find(l => l.host === 'github.com') ?? logins[0]
    if (!who) return 'No GitHub account found to read that file with.'
    const res = await $.http.fetch(`${restBase(who.host)}/repos/${remote[1]}/contents/${remote[2]}`, {
      headers: { ...restHeaders(who.token), Accept: 'application/vnd.github.raw' },
    })
    if (!res.ok) return `Couldn't read ${src} (HTTP ${res.status}).`
    text = res.text
  } else {
    text = await $.fs.read(src)
  }
  const history = ((await $.store.get('history')) as History | undefined) ?? {}
  let merged: { repos: number; days: number }
  try {
    merged = importTracker(history, JSON.parse(text))
  } catch (err) {
    return `Couldn't import ${src}: ${err instanceof Error ? err.message : err}`
  }
  await $.store.set('history', history)
  await saveShared($, { history })
  const snap = await read($, snapshot)
  if (snap) await update($, snapshot, () => withLifetime(snap, history))
  return `📥 Imported ${merged.days} days of clone history across ${merged.repos} repos. Lifetime totals updated.`
}

async function checkRelease($: Engine, who: Login, r: Repo): Promise<string> {
  const res = await $.http.fetch(`${restBase(who.host)}/repos/${r.owner}/${r.name}/releases?per_page=5`, {
    headers: restHeaders(who.token),
  })
  if (!res.ok) return `⚠ ${r.name}: couldn't read releases (HTTP ${res.status})`
  const releases = (JSON.parse(res.text) as any[]).filter(x => !x.draft)
  if (releases.length === 0) return `· ${r.name}: no published releases`
  const [latest, previous] = releases
  const names = (x: any): string[] => (x.assets ?? []).map((a: any) => a.name)
  const broken = (latest.assets ?? []).filter((a: any) => a.state !== 'uploaded' || a.size === 0).map((a: any) => a.name)
  const missing = previous ? missingAssets(names(latest), names(previous)) : []
  const count = names(latest).length
  if (missing.length === 0 && broken.length === 0) {
    return `✅ ${r.name} ${latest.tag_name}: ${count} asset${count === 1 ? '' : 's'}${previous ? `, matches ${previous.tag_name}` : ''}`
  }
  const lines = [`❌ ${r.name} ${latest.tag_name}: ${count} asset${count === 1 ? '' : 's'}`]
  for (const n of missing) lines.push(`   missing (was in ${previous.tag_name}): ${n}`)
  for (const n of broken) lines.push(`   broken upload: ${n}`)
  return lines.join('\n')
}

async function releaseCheck($: Engine, fallbackToken: string, args: string): Promise<string> {
  const snap = await read($, snapshot)
  if (!snap) return 'Repo Radar has not finished its first scan yet. Try again in a moment.'
  const want = args.trim().toLowerCase()
  const targets = snap.accounts.flatMap(a =>
    a.repos
      .filter(r => (want ? r.name.toLowerCase() === want || repoKey(r.owner, r.name).toLowerCase() === want : r.release))
      .map(r => ({ acct: a, repo: r })),
  )
  if (targets.length === 0) return want ? `No repo named "${args.trim()}" in Repo Radar.` : 'None of your repos have releases.'
  const logins = await discover($, fallbackToken)
  const results = await Promise.all(
    targets.map(({ acct, repo }) => {
      const who = logins.find(l => l.host === acct.host && (l.login === acct.login || !l.login))
      return who
        ? checkRelease($, who, repo).catch(err => `⚠ ${repo.name}: ${err}`)
        : Promise.resolve(`⚠ ${repo.name}: signed out of ${acct.login}`)
    }),
  )
  const bad = results.filter(r => r.startsWith('❌')).length
  return [`📦 Release check: ${results.length} repo${results.length === 1 ? '' : 's'}, ${bad} with problems`, ...results].join('\n')
}

async function announce($: Engine, before: Snapshot | null, snap: Snapshot, shared?: Ledger | null): Promise<void> {
  if (before) {
    // If the widget swept since our last look, it already notified for what it saw.
    const base = shared && shared.at > before.fetchedAt ? shared : toLedger(before)
    const news = changes(base, snap).map(describe)
    news.slice(0, TOAST_LIMIT).forEach(line => $.ui.toast(line, { timeoutMs: 8000 }))
    if (news.length > TOAST_LIMIT) $.ui.toast(`📡 +${news.length - TOAST_LIMIT} more updates`, { timeoutMs: 8000 })
    return
  }
  // First scan of this session: compare with where things stood last time.
  const ledger = (await $.store.get('ledger')) as Ledger | undefined
  if (!ledger || snap.fetchedAt - ledger.at < AWAY_MS) return
  const since = new Date(ledger.at).toISOString().slice(0, 10)
  const keys = dayKeys(snap.fetchedAt)
  const clones = snap.accounts
    .flatMap(a => a.repos)
    .reduce((n, r) => n + (r.traffic?.clones.reduce((m, c, i) => ((keys[i] ?? '') >= since ? m + c : m), 0) ?? 0), 0)
  const list = changes(ledger, snap)
  if (list.length === 0) return // nothing new: no "all quiet" card
  const line = `🌅 While you were away (${ago(new Date(ledger.at).toISOString(), snap.fetchedAt)}): ${summarize(list, clones)}`
  await update($, digest, () => [line, ...list.slice(0, 6).map(describe)].join('\n'))
  $.ui.toast(line, { timeoutMs: 10000 })
}

let isRefreshing = false

async function refresh($: Engine, fallbackToken: string): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    await update($, status, () => 'loading' as Status)
    const logins = await discover($, fallbackToken)
    if (logins.length === 0) {
      await update($, status, () => 'no-auth' as Status)
      $.ui.status(undefined)
      return
    }
    const now = await $.clock.now()
    const before = await read($, snapshot)
    const isTrafficDue = !before?.trafficAt || now - before.trafficAt > TRAFFIC_MS
    const oldTraffic = new Map(
      (before?.accounts ?? []).flatMap(a => a.repos).map(r => [repoKey(r.owner, r.name), r.traffic] as const),
    )
    const shared = await loadShared($)
    const history = mergeHistory(((await $.store.get('history')) as History | undefined) ?? {}, shared?.history)
    // GitHub hands back 14 days, so the first scan's window is where our own record starts.
    let watchedSince = (await $.store.get('watchedSince')) as string | undefined
    if (!watchedSince) {
      watchedSince = dayKeys(now)[0]!
      await $.store.set('watchedSince', watchedSince)
    }
    const accounts: Account[] = []
    for (const who of logins) {
      try {
        const acct = await fetchAccount($, who, now)
        if (isTrafficDue) await addTraffic($, who, acct, history)
        else for (const r of acct.repos) r.traffic = oldTraffic.get(repoKey(r.owner, r.name))
        accounts.push(acct)
      } catch (err) {
        accounts.push({ host: who.host, login: who.login || '?', repos: [], error: String(err) })
      }
    }
    const fresh: Snapshot = { accounts, fetchedAt: now, trafficAt: isTrafficDue ? now : (before?.trafficAt ?? now), watchedSince }
    const snap = isTrafficDue ? withLifetime(fresh, history) : fresh
    if (isTrafficDue) await $.store.set('history', history)
    // The widget may have swept more recently; its ledger then says what's already been announced.
    const sharedLedger = shared?.ledger
    const storeLedger = (await $.store.get('ledger')) as Ledger | undefined
    if (sharedLedger && (!storeLedger || sharedLedger.at > storeLedger.at)) await $.store.set('ledger', sharedLedger)
    await announce($, before, snap, shared?.ledger)
    await update($, snapshot, () => snap)
    await $.store.set('ledger', toLedger(snap))
    await saveShared($, { history, ledger: toLedger(snap), watchedSince })
    // First load: open the person's own repos; everything else starts folded.
    await update($, expanded, list => (list.length ? list : accounts.map(a => `${a.host}/${a.login}`)))
    await update($, status, () => 'ready' as Status)
    await update($, message, () => '')
  } catch (err) {
    await update($, status, () => 'error' as Status)
    await update($, message, () => String(err))
  } finally {
    isRefreshing = false
  }
}

export const register: Register = (on, options) => {
  const fallbackToken = String((options as Record<string, unknown>)?.github_token ?? '')
  let tick = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'repos', description: 'Open Repo Radar, your GitHub dashboard (/repos widget opens the desktop widget)' })
    await $.command.register({
      name: 'release-check',
      description: 'Check your latest releases have every asset the release before had (optionally name one repo)',
    })
    await $.command.register({
      name: 'repos-import',
      description: 'Import older clone history into Repo Radar: a JSON file path, or owner/repo:path on GitHub',
    })
    const savedHidden = await $.store.get('hiddenColumns')
    if (Array.isArray(savedHidden)) await update($, hiddenColumns, () => savedHidden.map(String))
    void refresh($, fallbackToken)
    $.clock.every(REFRESH_MS, () => void refresh($, fallbackToken))
    $.clock.every(TICK_MS, async () => {
      const snap = await read($, snapshot)
      if (!snap) return
      const lines = tickerLines(snap)
      $.ui.status(lines[tick++ % lines.length])
    })
    return next(e)
  })

  on('command.run', { command: 'repos' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'widget') return { text: await launchWidget($) }
    const opened = await $.ui.open({ id: PANE, title: '📡 Repo Radar', focus: true, closeOnEscape: true, rows: 26, columns: 98 })
    const snap = await read($, snapshot)
    if (!snap || (await $.clock.now()) - snap.fetchedAt > REFRESH_MS) void refresh($, fallbackToken)
    const where = e.presentation?.isFullscreen
      ? 'docked on the right'
      : 'above the prompt (turn on the fullscreen layout to dock it on the right)'
    return { text: opened.isPlaced ? `Repo Radar opened ${where}. Esc closes it.` : `Repo Radar couldn't open: ${'reason' in opened ? opened.reason : 'no room'}` }
  })

  on('command.run', { command: 'repos-import' }, async ($, e) => ({
    text: await importHistory($, fallbackToken, e.args ?? ''),
  }))

  on('command.run', { command: 'release-check' }, async ($, e) => ({
    text: await releaseCheck($, fallbackToken, e.args ?? ''),
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const state = await read($, status)
    const why = await read($, message)
    const open = await read($, expanded)
    const away = await read($, digest)
    const hidden = await read($, hiddenColumns)
    const now = await $.clock.now()
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const isWide = width >= 70
    const hasTraffic = width >= 88

    const toggle = (k: string) =>
      update($, expanded, list => (list.includes(k) ? list.filter(x => x !== k) : [...list, k]))

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={2}>
          <Text bold color="cyan">📡 REPO RADAR</Text>
          <Button key="refresh" label={state === 'loading' ? 'scanning…' : '↻ Refresh'} hotkey="r" onPress={() => void refresh($, fallbackToken)} />
        </Box>
        {snap && (
          <Text dimColor>
            {snap.accounts.length} account{snap.accounts.length === 1 ? '' : 's'} ·{' '}
            {snap.accounts.reduce((n, a) => n + a.repos.length, 0)} repos · swept {ago(new Date(snap.fetchedAt).toISOString(), now)} ago
            {e.props.isFocused ? ' · ↑↓ scroll · r refresh' : ' · Tab here to scroll'}
          </Text>
        )}
        {away !== '' && (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
            {away.split('\n').map((line, i) => (
              <Text key={`away:${i}`} bold={i === 0} color={i === 0 ? 'yellow' : undefined}>
                {line}
              </Text>
            ))}
            <Button key="dismiss-digest" plain dimColor label="dismiss" onPress={() => void update($, digest, () => '')} />
          </Box>
        )}
      </Box>
    )

    if (state === 'no-auth') {
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>No GitHub account found 🔌</Text>
          <Text>Sign in with the GitHub CLI, then press Refresh:</Text>
          <Text color="cyan">  gh auth login</Text>
          <Text dimColor>No gh? Paste a token into Repo Radar's github_token setting in /config.</Text>
        </Box>
      )
    }

    if (!snap) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>{state === 'error' ? `Scan failed: ${why}` : 'Sweeping the skies for repos…'}</Text>
        </Box>
      )
    }

    const longest = Math.max(10, ...snap.accounts.flatMap(a => a.repos.map(r => r.name.length + (r.isPrivate ? 3 : 0) + (r.isFork ? 2 : 0))))
    const zero = (n: number) => n === 0
    const since = snap.accounts
      .flatMap(a => a.repos)
      .map(r => r.traffic?.since)
      .filter((d): d is string => !!d)
      .sort()[0]

    // Every column but the name: its width, whether the pane has room, and how a row fills it.
    const COLUMNS: { id: string; label: string; width: number; fits: boolean; cell: (r: Repo) => RenderChildren }[] = [
      {
        id: 'lang', label: '◆', width: 2, fits: isWide,
        cell: r => <Text color={r.languageColor ?? undefined}>{r.languageColor ? '◆' : ' '}</Text>,
      },
      {
        id: 'stars', label: 'stars', width: 7, fits: true,
        cell: r => <Text color={zero(r.stars) ? undefined : 'yellow'} dimColor={zero(r.stars)}>★ {compact(r.stars)}</Text>,
      },
      {
        id: 'issues', label: 'issues', width: 7, fits: isWide,
        cell: r => <Text dimColor={zero(r.issues)}>{zero(r.issues) ? '·' : r.issues}</Text>,
      },
      {
        id: 'prs', label: 'PRs', width: 5, fits: isWide,
        cell: r => <Text dimColor={zero(r.prs)} color={r.prs ? 'magenta' : undefined}>{zero(r.prs) ? '·' : r.prs}</Text>,
      },
      {
        id: 'release', label: 'release', width: 12, fits: isWide,
        cell: r => <Text color="green" wrap="truncate">{r.release ?? ''}</Text>,
      },
      { id: 'pushed', label: 'pushed', width: 7, fits: true, cell: r => <Text dimColor>{ago(r.pushedAt, now)}</Text> },
      {
        id: 'clones', label: 'clones', width: 8, fits: hasTraffic,
        cell: r => (
          <Text color={r.traffic?.clonesLifetime ? 'cyan' : undefined} dimColor={!r.traffic?.clonesLifetime}>
            {r.traffic ? compact(r.traffic.clonesLifetime) : ''}
          </Text>
        ),
      },
      {
        id: 'views', label: 'views', width: 7, fits: hasTraffic,
        cell: r => <Text dimColor={!r.traffic?.viewsLifetime}>{r.traffic ? compact(r.traffic.viewsLifetime) : ''}</Text>,
      },
    ]
    const fitting = COLUMNS.filter(c => c.fits)
    const shown = fitting.filter(c => !hidden.includes(c.id))
    const folded = fitting.filter(c => hidden.includes(c.id))
    const used = shown.reduce((n, c) => n + c.width, 0)
    const nameWidth = Math.max(12, Math.min(longest + 2, 34, width - 8 - used))

    const toggleColumn = (id: string) =>
      update($, hiddenColumns, list => {
        const next = list.includes(id) ? list.filter(x => x !== id) : [...list, id]
        void $.store.set('hiddenColumns', next)
        void saveShared($, { hiddenColumns: next })
        return next
      })

    // Header buttons hide their column; a hidden column waits at the end as "+name".
    const columns = (scope: string) => (
      <Box paddingLeft={4}>
        <Box width={nameWidth}><Text dimColor>repo</Text></Box>
        {shown.map(c => (
          <Box key={`col:${scope}:${c.id}`} width={c.width} justifyContent="flex-end">
            <Button key={`hide:${scope}:${c.id}`} plain dimColor label={c.label} onPress={() => void toggleColumn(c.id)} />
          </Box>
        ))}
        {folded.map(c => (
          <Box key={`fold:${scope}:${c.id}`} marginLeft={1}>
            <Button key={`show:${scope}:${c.id}`} plain dimColor label={`+${c.label}`} onPress={() => void toggleColumn(c.id)} />
          </Box>
        ))}
      </Box>
    )

    const row = (r: Repo) => (
      <Box key={`${r.owner}/${r.name}`}>
        <Text color={DOT[r.health].color}>{DOT[r.health].glyph} </Text>
        <Box width={nameWidth}>
          <Text wrap="truncate" dimColor={r.health === 'archived'}>
            {r.name}
            {r.isPrivate ? ' 🔒' : ''}
            {r.isFork ? ' ⑂' : ''}
          </Text>
        </Box>
        {shown.map(c => (
          <Box key={`${r.owner}/${r.name}:${c.id}`} width={c.width} justifyContent="flex-end">
            {c.cell(r)}
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {snap.accounts.map(acct => {
          const owners = [...new Set(acct.repos.map(r => r.owner))].sort((a, b) =>
            a === acct.login ? -1 : b === acct.login ? 1 : a.localeCompare(b),
          )
          return (
            <Box key={`acct:${acct.host}/${acct.login}`} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
              <Text bold>
                🐙 {acct.login}
                <Text dimColor>{acct.host === 'github.com' ? '' : ` @ ${acct.host}`}</Text>
              </Text>
              {acct.error && <Text color="red">⚠ {acct.error}</Text>}
              {columns(`${acct.host}/${acct.login}`)}
              {owners.map(owner => {
                const k = `${acct.host}/${owner}`
                const repos = acct.repos.filter(r => r.owner === owner)
                const isOpen = open.includes(k)
                const showAll = open.includes(`${k}:all`)
                const shown = showAll ? repos : repos.slice(0, PREVIEW)
                const stars = repos.reduce((n, r) => n + r.stars, 0)
                const reds = repos.filter(r => r.health === 'red').length
                return (
                  <Box key={k} flexDirection="column">
                    <Box>
                      <Button key={`fold:${k}`} plain label={isOpen ? '▾' : '▸'} onPress={() => void toggle(k)} />
                      <Text bold color={owner === acct.login ? 'cyan' : 'blue'}> {owner}</Text>
                      <Text dimColor>  {repos.length} repos · ★{compact(stars)}</Text>
                      {reds > 0 && <Text color="red">  🔴 {reds}</Text>}
                    </Box>
                    {isOpen && <Box flexDirection="column" paddingLeft={2}>{shown.map(row)}</Box>}
                    {isOpen && repos.length > PREVIEW && (
                      <Box paddingLeft={2}>
                        <Button
                          key={`more:${k}`}
                          plain
                          dimColor
                          label={showAll ? 'show less' : `+${repos.length - PREVIEW} more`}
                          onPress={() => void toggle(`${k}:all`)}
                        />
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          )
        })}
        {hasTraffic && since && snap.watchedSince && (
          <Text dimColor>
            clones since {shortDate(since < snap.watchedSince ? since : snap.watchedSince, now)} · views since{' '}
            {shortDate(snap.watchedSince, now)} (GitHub only keeps 14 days of views)
          </Text>
        )}
        <Text dimColor><Text color="green">●</Text> active  <Text color="yellow">●</Text> quiet {STALE_DAYS}d+  <Text color="red">●</Text> CI failing  ○ archived</Text>
      </Box>
    )
  })
}
