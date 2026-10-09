// Scans GitHub the way the mod does and keeps ~/.claude/repo-radar/data.json.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { mergeHistory, dayKeys, repoKey, toLedger, changes, describe, summarize, record, missingAssets } = require('./lib')

const DIR = path.join(os.homedir(), '.claude', 'repo-radar')
const DATA = path.join(DIR, 'data.json')
const MOD_STORE = path.join(os.homedir(), '.claude', 'plugins', 'store')
const PAGE_LIMIT = 10 // pages of 50: each repo asks for releases, issues and PRs, so smaller pages keep GitHub from timing out
const STALE_DAYS = 90
const TRAFFIC_MS = 60 * 60 * 1000 // GitHub updates traffic about hourly
const TRAFFIC_LIMIT = 300 // per account, most recently pushed first: in practice every repo
const BATCH = 10 // repos fetched at once
const RELEASE_PAGES = 3 // up to 300 releases per repo
const AWAY_MS = 30 * 60 * 1000

const QUERY = `query($after: String) {
  viewer {
    login
    repositories(first: 50, after: $after,
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
      orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name url isPrivate isFork isArchived pushedAt viewerPermission
        owner { login }
        stargazerCount forkCount
        issues(states: OPEN, first: 5, orderBy: { field: CREATED_AT, direction: DESC }) {
          totalCount
          nodes { number title url createdAt author { login } comments(last: 1) { nodes { author { login } createdAt } } }
        }
        pullRequests(states: OPEN, first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { totalCount nodes { number title url isDraft } }
        latestRelease { tagName publishedAt }
        primaryLanguage { name color }
        defaultBranchRef { name target { ... on Commit { statusCheckRollup { state } } } }
        plugin: object(expression: "HEAD:.claude-plugin/plugin.json") { ... on Blob { text } }
        market: object(expression: "HEAD:.claude-plugin/marketplace.json") { ... on Blob { text } }
        releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { isDraft releaseAssets(first: 30) { nodes { name downloadCount } } }
        }
      }
    }
  }
}`

// Other people's repos the account starred or watches. Each list is the newest 100.
const FOLLOW_FIELDS = `nameWithOwner url description stargazerCount pushedAt isArchived
  latestRelease { tagName publishedAt url releaseAssets(first: 30) { nodes { name downloadUrl } } }
  primaryLanguage { name color }
  pluginJson: object(expression: "HEAD:.claude-plugin/plugin.json") { ... on Blob { text } }
  marketJson: object(expression: "HEAD:.claude-plugin/marketplace.json") { ... on Blob { text } }
  skillMd: object(expression: "HEAD:SKILL.md") { ... on Blob { text } }
  skillsDir: object(expression: "HEAD:skills") { ... on Tree { entries { name type object { ... on Tree { entries { name } } } } } }`
const FOLLOW_QUERY = `query {
  viewer {
    starredRepositories(first: 100, orderBy: { field: STARRED_AT, direction: DESC }) { nodes { ${FOLLOW_FIELDS} } }
    watching(first: 100) { nodes { ${FOLLOW_FIELDS} owner { login } viewerPermission } }
  }
}`

const graphqlUrl = host => (host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`)
const restBase = host => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)
const headers = token => ({ Authorization: `bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'repo-radar' })

const run = args =>
  new Promise(resolve =>
    execFile('gh', args, { windowsHide: true }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  )

function empty() {
  return { version: 1, fetchedAt: 0, trafficAt: 0, watchedSince: null, accounts: [], history: {}, ledger: null, digest: null, prefs: { hiddenColumns: [] } }
}

/** Reads data.json; on first run, carries over the mod's private store (history imported with /repos-import). */
function load() {
  if (fs.existsSync(DATA)) {
    // The mod may be mid-write; another read gets the whole file. Never migrate over a file that's there.
    for (let i = 0; ; i++) {
      try {
        return { ...empty(), ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }
      } catch (err) {
        if (i >= 3) throw err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
  }
  {
    const data = empty()
    try {
      const file = fs.readdirSync(MOD_STORE).find(f => f.startsWith('repo-radar_inline-'))
      if (file) {
        const s = JSON.parse(fs.readFileSync(path.join(MOD_STORE, file), 'utf8'))
        data.history = s.history ?? {}
        data.ledger = s.ledger ?? null
        data.watchedSince = s.watchedSince ?? null
        data.prefs.hiddenColumns = s.hiddenColumns ?? []
      }
    } catch {
      // no mod store yet
    }
    return data
  }
}

let saves = 0

/**
 * Atomic write: a reader never sees half a file. Each save gets its own temp name, since a click
 * (a pref, a dismiss) can save while a sweep is saving too.
 */
function save(data) {
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = `${DATA}.${process.pid}.${++saves}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, DATA)
}

async function logins() {
  let found = []
  const json = await run(['auth', 'status', '--json', 'hosts'])
  if (json.code === 0) {
    const hosts = JSON.parse(json.stdout).hosts
    found = Object.values(hosts).flat().filter(a => a.state === 'success').map(a => ({ host: a.host, login: a.login }))
  } else {
    const text = await run(['auth', 'status'])
    const out = `${text.stdout}\n${text.stderr}`
    found = [...out.matchAll(/Logged in to (\S+) (?:account|as) ([\w-]+)/g)].map(m => ({ host: m[1], login: m[2] }))
  }
  const out = []
  for (const a of found) {
    const r = await run(['auth', 'token', '--hostname', a.host, '--user', a.login])
    if (r.code === 0 && r.stdout.trim()) out.push({ ...a, token: r.stdout.trim() })
  }
  return out
}

/** The "version" field of a plugin.json, or null. */
function versionOf(text) {
  try {
    const v = JSON.parse(text ?? 'null')?.version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

// Auto-updaters fetch these on every check, so they'd inflate downloads.
const UPDATER_FILE = /\.(ya?ml|blockmap)$/i
const names = rel => rel.releaseAssets.nodes

function toRepo(node, now) {
  const releases = (node.releases?.nodes ?? []).filter(r => !r.isDraft)
  const ci = node.defaultBranchRef?.target?.statusCheckRollup?.state
  const stale = node.pushedAt && now - Date.parse(node.pushedAt) > STALE_DAYS * 86400 * 1000
  const health = node.isArchived ? 'archived' : ci === 'FAILURE' || ci === 'ERROR' ? 'red' : stale ? 'yellow' : 'green'
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
    issueList: node.issues.nodes.map(i => {
      const last = i.comments?.nodes?.[0]
      return { number: i.number, title: i.title, url: i.url, createdAt: i.createdAt, author: i.author?.login ?? null, lastBy: last?.author?.login ?? i.author?.login ?? null, lastAt: last?.createdAt ?? i.createdAt }
    }),
    defaultBranch: node.defaultBranchRef?.name ?? null,
    releaseAt: node.latestRelease?.publishedAt ?? null,
    pluginVersion: versionOf(node.plugin?.text),
    prList: node.pullRequests.nodes.map(p => ({ number: p.number, title: p.title, url: p.url, isDraft: p.isDraft })),
    release: node.latestRelease?.tagName ?? null,
    pushedAt: node.pushedAt,
    language: node.primaryLanguage?.name ?? null,
    languageColor: node.primaryLanguage?.color ?? null,
    health,
    canPush: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(node.viewerPermission),
    marketText: node.market?.text ?? null,
    kind: node.plugin || node.market ? 'plugin' : releases.length ? 'app' : 'other',
    downloads: releases.flatMap(names).filter(a => !UPDATER_FILE.test(a.name)).reduce((n, a) => n + a.downloadCount, 0),
    missingAssets: releases.length > 1 ? missingAssets(releases[0].releaseAssets.nodes.map(a => a.name), releases[1].releaseAssets.nodes.map(a => a.name)) : [],
  }
}

/**
 * One GraphQL call. GitHub sometimes answers a heavy query with an HTML error page (502/504)
 * instead of JSON, so read the text first and retry those a couple of times.
 */
async function graphql(who, query, variables) {
  let last = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, attempt * 2000))
    const res = await fetch(graphqlUrl(who.host), {
      method: 'POST',
      headers: { ...headers(who.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      last = `GitHub hiccuped (HTTP ${res.status})`
      continue
    }
    if (res.status >= 500) {
      last = body.message ?? `GitHub hiccuped (HTTP ${res.status})`
      continue
    }
    if (!res.ok || body.errors) return { error: body.errors?.[0]?.message ?? body.message ?? `HTTP ${res.status}` }
    return { data: body.data }
  }
  return { error: last }
}

/** A sweep that failed partway keeps the last good repo list, so the widget never drops to zeros. */
function keepLastGood(acct, data) {
  if (!acct.error) return acct
  const was = (data.accounts ?? []).find(a => a.host === acct.host && a.login === acct.login && a.repos.length)
  if (!was || was.repos.length <= acct.repos.length) return acct
  return { ...was, error: `${acct.error}. Showing your last sweep.` }
}

async function fetchAccount(who, now) {
  const repos = []
  let login = who.login
  let after = null
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const body = await graphql(who, QUERY, { after })
    if (body.error) return { host: who.host, login: login || '?', repos, error: body.error }
    const conn = body.data.viewer.repositories
    login = body.data.viewer.login
    repos.push(...conn.nodes.map(n => toRepo(n, now)))
    if (!conn.pageInfo.hasNextPage) break
    after = conn.pageInfo.endCursor
  }
  return { host: who.host, login, repos, error: null }
}

/**
 * Starred and watched repos, merged into `into` by owner/name. GitHub auto-watches your own repos,
 * so a watched repo you can push to isn't "following"; a starred one is kept wherever it lives.
 */
const SAFE_NAME = /^[\w.-]{1,100}$/
const parseJson = text => {
  try {
    return JSON.parse(text ?? 'null')
  } catch {
    return null
  }
}

/**
 * What a followed repo offers to install, read from its files: a plugin marketplace, a plugin (or mod),
 * skills, or an app's installers. Names come from strangers' files, so only plain ones are kept.
 */
function installable(n) {
  const out = []
  const market = parseJson(n.marketJson?.text)
  if (market && SAFE_NAME.test(market.name ?? '')) {
    const plugins = (market.plugins ?? []).map(p => ({ name: p.name, description: String(p.description ?? '').slice(0, 200) })).filter(p => SAFE_NAME.test(p.name ?? ''))
    if (plugins.length) out.push({ type: 'marketplace', name: market.name, plugins })
  }
  const plugin = parseJson(n.pluginJson?.text)
  if (!out.length && plugin && SAFE_NAME.test(plugin.name ?? '')) out.push({ type: 'plugin', name: plugin.name })
  if (!out.length && n.skillMd?.text) {
    // The skill's own name, from SKILL.md's front matter; the repo name if it has none.
    const named = /^---[\s\S]*?^name:\s*['"]?([\w.-]+)/m.exec(n.skillMd.text)?.[1]
    const name = named && SAFE_NAME.test(named) ? named : n.nameWithOwner.split('/')[1]
    out.push({ type: 'skill', name, skills: [name], root: true })
  }
  const skills = (n.skillsDir?.entries ?? [])
    .filter(e => e.type === 'tree' && SAFE_NAME.test(e.name) && (e.object?.entries ?? []).some(f => f.name === 'SKILL.md'))
    .map(e => e.name)
  if (!out.length && skills.length) out.push({ type: 'skill', name: n.nameWithOwner.split('/')[1], skills, root: false })
  const assets = (n.latestRelease?.releaseAssets?.nodes ?? []).filter(a => /\.(exe|msi|dmg|pkg|appimage|deb)$/i.test(a.name) && !/blockmap/i.test(a.name))
  if (assets.length) out.push({ type: 'app', assets: assets.map(a => ({ name: a.name, url: a.downloadUrl })) })
  return out
}

async function fetchFollowing(who, into) {
  const body = await graphql(who, FOLLOW_QUERY, {})
  if (body.error) throw new Error(body.error)
  const add = (n, flag) => {
    const key = n.nameWithOwner
    const was = into.get(key)
    into.set(key, {
      key,
      url: n.url,
      description: n.description ?? '',
      stars: n.stargazerCount,
      pushedAt: n.pushedAt,
      isArchived: n.isArchived,
      release: n.latestRelease ? { tag: n.latestRelease.tagName, at: n.latestRelease.publishedAt, url: n.latestRelease.url } : null,
      language: n.primaryLanguage?.name ?? null,
      languageColor: n.primaryLanguage?.color ?? null,
      install: installable(n),
      starred: Boolean(was?.starred || flag === 'starred'),
      watched: Boolean(was?.watched || flag === 'watched'),
    })
  }
  for (const n of body.data.viewer.starredRepositories.nodes) add(n, 'starred')
  for (const n of body.data.viewer.watching.nodes) {
    if (['ADMIN', 'MAINTAIN', 'WRITE'].includes(n.viewerPermission)) continue
    add(n, 'watched')
  }
}

/** Repos a marketplace lists as plugin sources count as plugins too, wherever their plugin.json lives. */
function markListedPlugins(accounts) {
  const repos = accounts.flatMap(a => a.repos)
  // owner/name (lowercase) -> where it's listed and the version the listing names, if any
  const listed = new Map()
  for (const r of repos) {
    let market
    try {
      market = JSON.parse(r.marketText ?? 'null')
    } catch {
      continue
    }
    for (const p of market?.plugins ?? []) {
      const src = p.source
      const keys = []
      if (src && typeof src === 'object' && src.repo) keys.push(String(src.repo).toLowerCase())
      for (const url of [typeof src === 'object' ? src?.url : null, p.homepage]) {
        const m = url && /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)
        if (m) keys.push(m[1].toLowerCase())
      }
      const localPath = typeof src === 'string' && src.startsWith('./') && src !== './' ? src.slice(2).replace(/\/$/, '') : null
      // A plugin can list itself too; the marketplace that keeps its own copy wins.
      for (const k of keys) if (!listed.get(k)?.localPath) listed.set(k, { market: r.name, marketRepo: repoKey(r.owner, r.name), localPath, version: typeof p.version === 'string' ? p.version : null })
    }
  }
  for (const a of accounts) for (const r of a.repos) {
    const hit = listed.get(`${r.owner}/${r.name}`.toLowerCase())
    if (hit) {
      r.kind = 'plugin'
      r.marketName = hit.market
      r.marketVersion = hit.version
      r.marketCopy = hit.localPath ? { repo: hit.marketRepo, path: hit.localPath } : null
    }
    delete r.marketText
  }
}

/** Runs `fn` over `list` a batch at a time, so a sweep never fires a hundred requests at once. */
async function inBatches(list, fn) {
  for (let i = 0; i < list.length; i += BATCH) await Promise.all(list.slice(i, i + BATCH).map(fn))
}

/** GitHub keeps only 14 days of traffic, so every repo we can push to is checked: a skipped day is gone for good. */
async function addTraffic(who, acct, history) {
  const picks = acct.repos.filter(r => r.canPush && r.health !== 'archived').slice(0, TRAFFIC_LIMIT)
  await inBatches(picks, async r => {
    try {
      const base = `${restBase(who.host)}/repos/${r.owner}/${r.name}/traffic`
      const [c, v] = await Promise.all([fetch(`${base}/clones`, { headers: headers(who.token) }), fetch(`${base}/views`, { headers: headers(who.token) })])
      if (!c.ok || !v.ok) return
      const entry = (history[repoKey(r.owner, r.name)] ??= { clones: {}, views: {} })
      record(entry.clones, (await c.json()).clones ?? [])
      record(entry.views, (await v.json()).views ?? [])
    } catch {
      // traffic is a bonus; a failure leaves the row without it
    }
  })
}

const getJson = async (who, url) => {
  const res = await fetch(url, { headers: headers(who.token) })
  return res.ok ? res.json() : null
}

/**
 * The extras that go stale the moment a release goes out: commits since it, and the marketplace's copy
 * of the plugin. Notes which release they were read against, so a new one re-reads them before the hour is up.
 */
async function addReleaseExtras(who, r, x) {
  try {
    if (r.release && r.defaultBranch) {
      const cmp = await getJson(who, `${restBase(who.host)}/repos/${r.owner}/${r.name}/compare/${encodeURIComponent(r.release)}...${encodeURIComponent(r.defaultBranch)}`)
      x.unreleased = cmp ? cmp.ahead_by : x.unreleased ?? null
    } else x.unreleased = null
  } catch {}
  try {
    // The marketplace's own copy of this plugin, when it keeps one (source "./plugins/name").
    if (r.marketCopy) {
      const res = await fetch(`${restBase(who.host)}/repos/${r.marketCopy.repo}/contents/${r.marketCopy.path}/.claude-plugin/plugin.json`, {
        headers: { ...headers(who.token), Accept: 'application/vnd.github.raw' },
      })
      x.marketVersion = res.ok ? versionOf(await res.text()) : null
    }
  } catch {}
  x.release = r.release
}

/**
 * The hourly extras for repos you can push to, kept in data.extras by owner/name:
 * commits since the latest release, open Dependabot alerts, and where visitors came from.
 * Each is a bonus: a repo without access (or with Dependabot off) just goes without.
 */
async function addExtras(who, acct, data) {
  const base = r => `${restBase(who.host)}/repos/${r.owner}/${r.name}`
  const today = new Date().toISOString().slice(0, 10)
  data.extras ??= {}
  data.referrerLog ??= {}
  const picks = acct.repos.filter(r => r.canPush && r.health !== 'archived').slice(0, TRAFFIC_LIMIT)
  await inBatches(picks, async r => {
    const key = repoKey(r.owner, r.name)
    const x = (data.extras[key] ??= {})
    await addReleaseExtras(who, r, x)
    try {
      const alerts = await getJson(who, `${base(r)}/dependabot/alerts?state=open&per_page=20`)
      if (Array.isArray(alerts)) {
        x.alerts = alerts.map(a => ({
          number: a.number,
          severity: a.security_advisory?.severity ?? a.security_vulnerability?.severity ?? 'unknown',
          pkg: a.dependency?.package?.name ?? a.security_vulnerability?.package?.name ?? '?',
          summary: a.security_advisory?.summary ?? '',
          url: a.html_url,
        }))
      }
    } catch {}
    try {
      const [refs, paths] = await Promise.all([
        getJson(who, `${base(r)}/traffic/popular/referrers`),
        getJson(who, `${base(r)}/traffic/popular/paths`),
      ])
      if (Array.isArray(refs)) {
        x.referrers = refs.map(f => ({ name: f.referrer, count: f.count, uniques: f.uniques }))
        // GitHub only shows the last 14 days, so keep one snapshot a day.
        if (refs.length) (data.referrerLog[key] ??= {})[today] = x.referrers
      }
      if (Array.isArray(paths)) x.paths = paths.slice(0, 5).map(p => ({ path: p.path, title: p.title, count: p.count, uniques: p.uniques }))
    } catch {}
  })
}

const MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]
const passed = n => MILESTONES.filter(m => n >= m).pop() ?? 0

/** "🎉 marketplace passed 1,000 clones!" The first sweep only takes note; nothing is announced for old ground. */
function milestones(data, news) {
  const isFirst = !data.milestones
  data.milestones ??= {}
  for (const r of data.accounts.flatMap(a => a.repos)) {
    const key = repoKey(r.owner, r.name)
    const clones = Object.values(data.history[key]?.clones ?? {}).reduce((n, c) => n + c, 0)
    const now = { stars: r.stars, clones, downloads: r.downloads ?? 0 }
    const was = data.milestones[key]
    for (const [metric, n] of Object.entries(now)) {
      const mark = passed(n)
      if (!isFirst && was && mark > (was[metric] ?? 0)) news.push(`🎉 ${r.name} passed ${mark.toLocaleString('en-US')} ${metric}!`)
    }
    data.milestones[key] = Object.fromEntries(Object.entries(now).map(([m, n]) => [m, Math.max(passed(n), was?.[m] ?? 0)]))
  }
}

/** Lifetime downloads over every release, not just the 10 the GraphQL query sees. */
async function addDownloads(who, acct) {
  const picks = acct.repos.filter(r => r.release || r.downloads)
  await inBatches(picks, async r => {
    try {
      let total = 0
      for (let page = 1; page <= RELEASE_PAGES; page++) {
        const res = await fetch(`${restBase(who.host)}/repos/${r.owner}/${r.name}/releases?per_page=100&page=${page}`, { headers: headers(who.token) })
        if (!res.ok) return
        const list = await res.json()
        for (const rel of list) {
          if (rel.draft) continue
          for (const a of rel.assets ?? []) if (!UPDATER_FILE.test(a.name)) total += a.download_count
        }
        if (list.length < 100) break
      }
      r.downloads = Math.max(r.downloads, total)
    } catch {
      // keeps the GraphQL count
    }
  })
}

/**
 * One sweep. Returns { data, news } where news is the list of change lines to notify.
 * `force` refetches traffic even if it's not due.
 */
async function scan({ force = false } = {}) {
  const data = load()
  const now = Date.now()
  const who = await logins()
  if (who.length === 0) return { data, news: [], error: 'no-auth' }
  const trafficDue = force || !data.trafficAt || now - data.trafficAt > TRAFFIC_MS
  data.watchedSince ??= dayKeys(now)[0]
  const accounts = []
  for (const w of who) {
    try {
      accounts.push(keepLastGood(await fetchAccount(w, now), data))
    } catch (err) {
      accounts.push(keepLastGood({ host: w.host, login: w.login || '?', repos: [], error: String(err) }, data))
    }
  }
  // Before the hourly pass: it reads each plugin's marketplace copy, which this finds.
  markListedPlugins(accounts)
  for (const [i, w] of who.entries()) {
    const acct = accounts[i]
    if (acct.error) continue // a kept last-good list already has its numbers
    try {
      if (trafficDue) {
        await addTraffic(w, acct, data.history)
        await addDownloads(w, acct)
        await addExtras(w, acct, data)
      } else {
        // Between hourly passes, keep the full download counts from the last one.
        const was = new Map((data.accounts ?? []).flatMap(a => a.repos).map(r => [repoKey(r.owner, r.name), r.downloads ?? 0]))
        for (const r of acct.repos) r.downloads = Math.max(r.downloads, was.get(repoKey(r.owner, r.name)) ?? 0)
        // A release since the last pass: re-read what it changed, so the widget doesn't flag a mismatch for up to an hour.
        const fresh = acct.repos.filter(r => {
          const x = data.extras?.[repoKey(r.owner, r.name)]
          return x && x.release !== r.release
        })
        await inBatches(fresh, r => addReleaseExtras(w, r, data.extras[repoKey(r.owner, r.name)]))
      }
    } catch {
      // the repo list still stands without its extras
    }
  }
  const snap = { accounts, fetchedAt: now }
  let news = []

  // Following: a failure keeps the last list rather than emptying the tab.
  const follows = new Map()
  let followOk = true
  for (const w of who) {
    try {
      await fetchFollowing(w, follows)
    } catch {
      followOk = false
    }
  }
  if (followOk) {
    const before = new Map((data.following ?? []).map(f => [f.key, f]))
    const isFirst = !data.following
    data.followSeen ??= {}
    for (const f of follows.values()) {
      const old = before.get(f.key)
      // A newly followed repo, or the first sweep ever, starts with nothing new.
      if (isFirst || !old) data.followSeen[f.key] = f.release?.tag ?? null
      // Notify for new releases only in repos you watch; starred ones just get the NEW badge.
      else if (f.watched && f.release && f.release.tag !== old.release?.tag) news.push(`🚀 ${f.key} shipped ${f.release.tag}`)
    }
    data.following = [...follows.values()]
  }
  let isNewDigest = false
  if (data.ledger) {
    const list = changes(data.ledger, snap)
    news = [...list.map(describe), ...news]
    // Only real news makes a digest: no "all quiet" card after the PC wakes.
    if (list.length && now - data.ledger.at >= AWAY_MS) {
      isNewDigest = true
      const since = new Date(data.ledger.at).toISOString().slice(0, 10)
      const clones = Object.values(data.history).reduce(
        (n, e) => n + Object.entries(e.clones).reduce((m, [d, c]) => (d >= since ? m + c : m), 0),
        0,
      )
      data.digest = { at: now, since: data.ledger.at, line: summarize(list, clones), items: news.slice(0, 6) }
    }
  }
  // An issue closed from the widget while we swept is still open in what we fetched.
  dropClosed(accounts)
  data.accounts = accounts
  data.logins = who.map(w => w.login)
  data.fetchedAt = now
  if (trafficDue) data.trafficAt = now
  data.ledger = toLedger(snap)
  milestones(data, news)
  // Things may have changed on disk while we swept: the mod's days, prefs, a dismissed digest.
  try {
    const disk = load()
    mergeHistory(data.history, disk.history)
    data.prefs = { ...data.prefs, ...disk.prefs }
    if (!isNewDigest) data.digest = disk.digest
    // What you've seen in Following is marked while we sweep; keep the newer marks.
    data.followSeen = { ...data.followSeen, ...disk.followSeen }
  } catch {}
  save(data)
  return { data, news, error: null }
}

// Issues closed from the widget lately, `owner/name#number` -> when. A sweep that was already
// running (or GitHub's lagging search) would otherwise bring them back.
const closedLately = new Map()
const CLOSED_HOLD_MS = 10 * 60 * 1000

function dropClosed(accounts) {
  const now = Date.now()
  for (const [k, at] of closedLately) if (now - at > CLOSED_HOLD_MS) closedLately.delete(k)
  for (const r of (accounts ?? []).flatMap(a => a.repos)) {
    const gone = (r.issueList ?? []).filter(i => closedLately.has(`${repoKey(r.owner, r.name)}#${i.number}`))
    if (!gone.length) continue
    r.issues = Math.max(0, r.issues - gone.length)
    r.issueList = r.issueList.filter(i => !gone.includes(i))
  }
}

/**
 * Closes an issue as completed, as the account whose sweep found the repo.
 * On success the issue leaves data.json right away instead of waiting for the next sweep.
 */
async function closeIssue(key, number) {
  const data = load()
  const acct = (data.accounts ?? []).find(a => a.repos.some(r => repoKey(r.owner, r.name) === key))
  const repo = acct?.repos.find(r => repoKey(r.owner, r.name) === key)
  if (!repo) return { ok: false, why: 'That repo isn’t in the last sweep.' }
  const who = (await logins()).find(w => w.host === acct.host && w.login === acct.login)
  if (!who) return { ok: false, why: `Not signed in to gh as ${acct.login}.` }
  const res = await fetch(`${restBase(who.host)}/repos/${repo.owner}/${repo.name}/issues/${number}`, {
    method: 'PATCH',
    headers: { ...headers(who.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  })
  if (!res.ok) return { ok: false, why: `GitHub said ${res.status}${res.status === 403 || res.status === 404 ? ' (no permission to close it?)' : ''}` }
  closedLately.set(`${key}#${number}`, Date.now())
  const disk = load()
  dropClosed(disk.accounts)
  save(disk)
  return { ok: true }
}

module.exports = { DATA, load, save, scan, closeIssue }
