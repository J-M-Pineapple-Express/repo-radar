// Renders data.json. The main process owns scanning; this page only draws.
const $ = id => document.getElementById(id)
const DAY = 86400 * 1000
const NEEDS_PREVIEW = 4

let data = null
let error = ''
let update = null // { version, ready } once a newer release is found
let needsOpen = false
const openRepos = new Set()

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },
}
let tab = store.get('tab', 'plugin')
if (!['plugin', 'app', 'other', 'follow'].includes(tab)) tab = 'plugin'

// What the ⚙ menu can hide. Kept in data.json prefs so it follows the data.
const OPTIONS = [
  ['tile-stars', 'Stars tile'], ['tile-clones', 'Clones tile'], ['tile-downloads', 'Downloads tile'], ['tile-ci', 'CI tile'],
  ['trend', 'Clones chart'], ['needs', 'Needs Attention'], ['stars', '⭐ on rows'], ['week', 'This week'],
  ['release', 'Release tag'], ['language', 'Language'], ['pushed', 'Last push'],
]
const hidden = () => new Set(data?.prefs?.widgetHidden ?? [])

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const compact = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
const ago = (t, now = Date.now()) => {
  if (!t) return '—'
  const s = Math.max(0, (now - (typeof t === 'number' ? t : Date.parse(t))) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`
  if (s < 86400 * 730) return `${Math.round(s / (86400 * 30))}mo ago`
  return `${Math.round(s / (86400 * 365))}y ago`
}
const dayKeys = (days, now = Date.now()) =>
  Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10))
const sum = obj => Object.values(obj ?? {}).reduce((n, c) => n + c, 0)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const entry = r => data.history?.[`${r.owner}/${r.name}`]

/** Every repo, tagged with its account's login. */
const allRepos = () => data.accounts.flatMap(a => a.repos.map(r => ({ ...r, login: a.login })))

/** Clones this week and the week before, from the saved history. */
function week(r) {
  const e = entry(r)
  const keys = dayKeys(14)
  const count = ks => ks.reduce((n, k) => n + (e?.clones?.[k] ?? 0), 0)
  return { now: count(keys.slice(7)), before: count(keys.slice(0, 7)) }
}

/** An area chart as SVG markup. `w`/`h` are viewBox units; the SVG stretches to fit. */
function chart(values, keys, w, h) {
  const max = Math.max(1, ...values)
  const step = w / Math.max(1, values.length - 1)
  const pts = values.map((v, i) => [i * step, h - 2 - (v / max) * (h - 6)])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const hits = values
    .map((v, i) => `<rect class="hit" x="${(i * step - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${h}"><title>${keys[i]}: ${plural(v, 'clone')}</title></rect>`)
    .join('')
  return `<defs><linearGradient id="grad" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e89070" stop-opacity="0.35"/><stop offset="1" stop-color="#e89070" stop-opacity="0"/></linearGradient></defs>
    <path class="area" d="${line}L${w},${h}L0,${h}Z"/><path class="line" d="${line}"/>${hits}`
}

function renderTiles(repos) {
  const hide = hidden()
  const red = repos.filter(r => r.health === 'red')
  const clones = Object.values(data.history ?? {}).reduce((n, e) => n + sum(e.clones), 0)
  const downloads = repos.reduce((n, r) => n + (r.downloads ?? 0), 0)
  const tiles = [
    ['tile-stars', compact(repos.reduce((n, r) => n + r.stars, 0)), '⭐ stars'],
    ['tile-clones', compact(clones), '📥 clones', 'Lifetime clones across every repo. A plugin install clones its repo.'],
    ['tile-downloads', compact(downloads), '⬇ downloads', 'Release downloads (auto-updater checks not counted)'],
    ['tile-ci', red.length || '✓', red.length ? '🔴 CI failing' : 'CI passing', red.map(r => r.name).join(', ')],
  ].filter(([id]) => !hide.has(id))
  $('tiles').innerHTML = tiles
    .map(([id, n, l, tip]) => `<div class="tile${id === 'tile-ci' && red.length ? ' bad' : ''}" title="${esc(tip ?? '')}"><div class="n">${n}</div><div class="l">${l}</div></div>`)
    .join('')
  $('tiles').classList.toggle('hidden', tiles.length === 0)
}

function renderTrend() {
  const keys = dayKeys(30)
  const values = keys.map(k => Object.values(data.history ?? {}).reduce((n, e) => n + (e.clones?.[k] ?? 0), 0))
  $('trend').classList.toggle('hidden', hidden().has('trend'))
  $('trend-sum').textContent = `${compact(values.reduce((a, b) => a + b, 0))} total`
  $('trend-svg').innerHTML = chart(values, keys, 300, 54)
}

const ISSUES_EACH = 3 // per repo; the rest fold into "+N more"

const SEVERITY = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3 }
const bare = v => String(v ?? '').replace(/^v/i, '')

/** plugin.json, the marketplace's copy and the latest release, where each has a version. Null when they agree. */
function versionDrift(r) {
  const x = data.extras?.[`${r.owner}/${r.name}`] ?? {}
  const seen = [
    ['plugin.json', r.pluginVersion],
    [`${r.marketName ?? 'marketplace'} copy`, x.marketVersion ?? r.marketVersion],
    ['release', r.release],
  ].filter(([, v]) => v)
  return new Set(seen.map(([, v]) => bare(v))).size > 1 ? seen : null
}

/** Has someone else had the last word on this issue? "You" is every account gh is signed into. */
const isWaiting = i => i.lastBy && !(data.logins ?? []).includes(i.lastBy)

/**
 * Things worth a look: failing CI, security alerts, releases missing assets, plugin versions out of step,
 * then each open issue (the ones waiting on you first) and PR, then work waiting to ship. Each can go to Claude.
 */
function needs(repos) {
  const out = []
  const mine = repos.filter(r => r.health !== 'archived' && !r.isFork && r.canPush)
  const key = r => `${r.owner}/${r.name}`
  const extras = r => data.extras?.[key(r)] ?? {}
  for (const r of mine.filter(r => r.health === 'red')) {
    out.push({ id: `ci:${key(r)}`, icon: '🔴', text: `<b>${esc(r.name)}</b> CI is failing`, url: `${r.url}/actions`, task: { kind: 'ci', repo: key(r) }, sig: r.pushedAt ?? '' })
  }
  for (const r of mine) {
    const alerts = [...(extras(r).alerts ?? [])].sort((p, q) => (SEVERITY[p.severity] ?? 9) - (SEVERITY[q.severity] ?? 9))
    for (const al of alerts.slice(0, ISSUES_EACH)) {
      out.push({ id: `alert:${key(r)}#${al.number}`, icon: '🔒', text: `<b>${esc(r.name)}</b> ${esc(al.pkg)} <span class="sev ${esc(al.severity)}">${esc(al.severity)}</span> ${esc(al.summary)}`, url: al.url, tip: 'Dependabot security alert', task: { kind: 'alert', repo: key(r), number: al.number } })
    }
    if (alerts.length > ISSUES_EACH) out.push({ id: `alerts:${key(r)}`, icon: '🔒', text: `<b>${esc(r.name)}</b> +${plural(alerts.length - ISSUES_EACH, 'more security alert')}`, url: `${r.url}/security/dependabot` })
  }
  for (const r of mine.filter(r => r.missingAssets?.length)) {
    out.push({ id: `assets:${key(r)}`, icon: '📦', text: `<b>${esc(r.name)}</b> ${esc(r.release)} is missing ${esc(r.missingAssets.join(', '))}`, url: `${r.url}/releases`, tip: 'The release before it had these files', task: { kind: 'assets', repo: key(r) }, sig: r.release ?? '' })
  }
  for (const r of mine.filter(r => r.kind === 'plugin')) {
    const drift = versionDrift(r)
    if (!drift) continue
    const text = drift.map(([where, v]) => `${esc(where)} ${esc(v)}`).join(' · ')
    out.push({ id: `sync:${key(r)}`, icon: '🧩', text: `<b>${esc(r.name)}</b> versions differ: ${text}`, url: r.url, tip: 'plugin.json, the marketplace copy and the release should name the same version', task: { kind: 'sync', repo: key(r) }, sig: text })
  }
  const issueItems = []
  for (const r of mine.filter(r => r.issues)) {
    const list = [...(r.issueList ?? [])].sort((p, q) => isWaiting(q) - isWaiting(p) || Date.parse(p.lastAt ?? 0) - Date.parse(q.lastAt ?? 0))
    for (const i of list.slice(0, ISSUES_EACH)) {
      const waiting = isWaiting(i) ? `<span class="waiting" title="${esc(i.lastBy)} had the last word">💬 ${esc(ago(i.lastAt).replace(' ago', ''))}</span> ` : ''
      issueItems.push({ waiting: Boolean(waiting), at: Date.parse(i.lastAt ?? 0) || 0, item: { id: `issue:${key(r)}#${i.number}`, icon: '🐛', text: `${waiting}<b>${esc(r.name)}</b> #${i.number} ${esc(i.title)}`, url: i.url, task: { kind: 'issue', repo: key(r), number: i.number } } })
    }
    const rest = r.issues - Math.min(list.length, ISSUES_EACH)
    if (rest > 0) issueItems.push({ waiting: false, at: Infinity, item: { id: `issues:${key(r)}`, icon: '🐛', text: `<b>${esc(r.name)}</b> +${plural(rest, 'more open issue')}`, url: `${r.url}/issues` } })
  }
  // People waiting on a reply come first, longest wait at the top.
  issueItems.sort((p, q) => q.waiting - p.waiting || p.at - q.at)
  out.push(...issueItems.map(x => x.item))
  for (const r of mine.filter(r => r.prs)) {
    const list = (r.prList ?? []).filter(p => !p.isDraft)
    for (const p of list.slice(0, ISSUES_EACH)) {
      out.push({ id: `pr:${key(r)}#${p.number}`, icon: '🔀', text: `<b>${esc(r.name)}</b> PR #${p.number} ${esc(p.title)}`, url: p.url, task: { kind: 'pr', repo: key(r), number: p.number }, verb: 'review' })
    }
    const rest = r.prs - Math.min(list.length, ISSUES_EACH)
    if (rest > 0) out.push({ id: `prs:${key(r)}`, icon: '🔀', text: `<b>${esc(r.name)}</b> +${plural(rest, 'more open PR')}`, url: `${r.url}/pulls` })
  }
  // Finished-but-unreleased work is worth doing, but after anything someone is waiting on.
  for (const r of mine.filter(r => extras(r).unreleased > 0)) {
    const n = extras(r).unreleased
    out.push({ id: `ship:${key(r)}`, icon: '🚢', text: `<b>${esc(r.name)}</b> ${plural(n, 'commit')} since ${esc(r.release)}`, url: `${r.url}/compare/${encodeURIComponent(r.release)}...${encodeURIComponent(r.defaultBranch ?? 'HEAD')}`, tip: 'Finished work that isn’t in a release yet', task: { kind: 'ship', repo: key(r) }, verb: 'ship', sig: String(n) })
  }
  return out
}

// What each Fix button last did, by item id: 'opening' | 'opened' | an error message.
const fixState = new Map()

function fixButton(i) {
  if (!i.task) return ''
  const state = fixState.get(i.id)
  const label = state === 'opening' ? '…' : state === 'opened' ? '✓ Opened' : i.verb === 'review' ? '👀 Review' : i.verb === 'ship' ? '🚢 Ship it' : '🔧 Fix'
  const tip = state && state !== 'opening' && state !== 'opened' ? state : i.verb === 'review' ? 'Open Claude to review this PR' : i.verb === 'ship' ? 'Open Claude to prepare a release (it asks before publishing)' : 'Open Claude to fix this'
  return `<button class="fix${state === 'opened' ? ' done' : ''}${tip === state ? ' bad' : ''}" data-fix="${esc(i.id)}" title="${esc(tip)}">${label}</button>`
}

// Items you marked ✓ Done, by id -> signature. A new push (CI) or a new release (assets) changes the
// signature, so the item comes back. Kept in prefs, so it survives restarts. GitHub is never touched.
const doneMap = () => data?.prefs?.done ?? {}
const isDone = i => i.id in doneMap() && doneMap()[i.id] === (i.sig ?? '')

function setDone(next) {
  data.prefs = { ...data.prefs, done: next }
  window.radar.setPrefs({ done: next })
  render()
}

/** ✓ Done hides an item from your list. Issues get Close (on GitHub) instead. */
function doneButton(i) {
  if (i.task?.kind === 'issue') return ''
  return `<button class="fix" data-done="${esc(i.id)}" title="Hide this from your list. GitHub isn't touched.">✓ Done</button>`
}

// What each Close button is doing, by item id: 'confirm' | 'closing' | an error message.
const closeState = new Map()

function closeButton(i) {
  if (i.task?.kind !== 'issue') return ''
  const state = closeState.get(i.id)
  const label = state === 'confirm' ? `Close #${i.task.number}?` : state === 'closing' ? '…' : '✓ Close'
  const bad = state && state !== 'confirm' && state !== 'closing'
  const tip = bad ? state : state === 'confirm' ? 'Click again to close it on GitHub' : 'Close this issue on GitHub'
  return `<button class="fix${state === 'confirm' ? ' armed' : ''}${bad ? ' bad' : ''}" data-close="${esc(i.id)}" title="${esc(tip)}">${label}</button>`
}

function renderNeeds(repos) {
  const d = data.digest
  const all = needs(repos)
  const items = all.filter(i => !isDone(i))
  const doneCount = all.length - items.length
  const show = !hidden().has('needs') && (d || items.length || doneCount)
  $('needs').classList.toggle('hidden', !show)
  if (!show) return
  const news = d
    ? `<div class="news"><div class="news-head"><span>🌅 While you were away (${ago(d.since)}): ${esc(d.line)}</span><button id="digest-x" title="Dismiss">×</button></div>
       ${(d.items ?? []).map(i => `<div class="news-item">${esc(i)}</div>`).join('')}</div>`
    : ''
  const visible = needsOpen ? items : items.slice(0, NEEDS_PREVIEW)
  const more = items.length - visible.length
  $('needs').innerHTML =
    news +
    (items.length ? `<div class="needs-title">⚠️ Needs Attention <span class="dim">${items.length}</span></div>` : '') +
    visible.map(i => `<div class="need" data-open="${esc(i.url)}" title="${esc(i.tip ?? 'Open on GitHub')}"><span>${i.icon}</span><span class="need-text">${i.text}</span><span class="go">↗</span>${fixButton(i)}${closeButton(i)}${doneButton(i)}</div>`).join('') +
    (!items.length && doneCount ? '<div class="needs-title">✅ All clear</div>' : '') +
    (more > 0 ? `<button class="need-more" id="needs-more">+${more} more</button>` : needsOpen && items.length > NEEDS_PREVIEW ? '<button class="need-more" id="needs-more">show less</button>' : '') +
    (doneCount ? `<button class="need-more" id="done-reset" title="Bring back the items you marked done">↺ ${doneCount} done</button>` : '')
}

/** Where the last 14 days of visitors came from, and what they read. */
function visitors(r) {
  const x = data.extras?.[`${r.owner}/${r.name}`]
  const refs = x?.referrers ?? []
  const paths = (x?.paths ?? []).filter(p => p.path !== `/${r.owner}/${r.name}`)
  if (!refs.length && !paths.length) return ''
  const list = items => items.map(([label, n, tip]) => `<span class="chip" title="${esc(tip)}">${esc(label)} <b>${n}</b></span>`).join('')
  return `<div class="visitors">
    ${refs.length ? `<div><span class="dim">🔗 From</span> ${list(refs.slice(0, 5).map(f => [f.name, f.count, `${f.uniques} ${f.uniques === 1 ? 'person' : 'people'} · last 14 days`]))}</div>` : ''}
    ${paths.length ? `<div><span class="dim">📄 Read</span> ${list(paths.slice(0, 3).map(p => [p.path.split('/').slice(3).join('/') || 'home', p.count, p.title]))}</div>` : ''}
  </div>`
}

/** The one or two numbers that matter for this kind of repo. Zeros never show. */
function headline(r) {
  const hide = hidden()
  const parts = []
  if (r.kind === 'plugin') {
    const n = sum(entry(r)?.clones)
    if (n) parts.push(`<span title="Lifetime clones. A plugin install clones its repo.">📥 ${compact(n)}</span>`)
  } else if (r.kind === 'app' && r.downloads) {
    parts.push(`<span title="Release downloads">⬇ ${compact(r.downloads)}</span>`)
  }
  if (r.stars && !hide.has('stars')) parts.push(`<span title="Stars">⭐ ${compact(r.stars)}</span>`)
  return parts.join('')
}

function repoRow(r) {
  const hide = hidden()
  const key = `${r.owner}/${r.name}`
  const e = entry(r)
  const w = week(r)
  const trend =
    r.kind !== 'other' && w.now && !hide.has('week')
      ? `<span class="${w.now > w.before ? 'up' : ''}" title="Clones this week (last week: ${w.before})">${w.now > w.before ? '↑' : w.now < w.before ? '↓' : '→'} ${w.now} this wk</span>`
      : ''
  const sub = [
    r.owner !== r.login ? `<span class="org" title="${esc(r.owner)}">🏢 ${esc(r.owner)}</span>` : '',
    r.release && !hide.has('release') ? `<span class="tag">${esc(r.release)}</span>` : '',
    trend,
    r.language && !hide.has('language') ? `<span><span class="lang" style="background:${esc(r.languageColor ?? '#888')}"></span> ${esc(r.language)}</span>` : '',
    !hide.has('pushed') ? `<span>pushed ${ago(r.pushedAt)}</span>` : '',
  ].filter(Boolean).join('<span class="sep">·</span>')
  const isOpen = openRepos.has(key)
  let detail = ''
  if (isOpen) {
    const keys = dayKeys(30)
    const since = e ? [...Object.keys(e.clones), ...Object.keys(e.views)].sort()[0] : null
    const facts = [
      `📥 ${compact(sum(e?.clones))} clones`,
      `👁 ${compact(sum(e?.views))} views`,
      r.downloads ? `⬇ ${compact(r.downloads)} downloads` : '',
      `🍴 ${r.forks} forks`,
      since ? `since ${since}` : '',
    ].filter(Boolean)
    detail = `<div class="detail">
      <div class="facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
      ${r.canPush ? `<svg viewBox="0 0 300 32" preserveAspectRatio="none">${chart(keys.map(k => e?.clones?.[k] ?? 0), keys, 300, 32)}</svg>` : '<div class="dim">No traffic: you can\'t push to this repo.</div>'}
      ${visitors(r)}
      <div class="btns">
        <button data-open="${esc(r.url)}">Open on GitHub ↗</button>
        <button data-open="${esc(r.url)}/releases">Releases ↗</button>
        ${r.issues ? `<button data-open="${esc(r.url)}/issues">Issues ↗</button>` : ''}
      </div></div>`
  }
  const badge = r.isPrivate ? '<span class="badge" title="Private">🔒</span>' : r.isFork ? '<span class="badge" title="Fork">⑂</span>' : ''
  return `<div class="repo${isOpen ? ' open' : ''}" data-repo="${esc(key)}">
    <div class="repo-top"><span class="dot ${r.health}" title="${{ green: 'Healthy', yellow: 'No push in 90+ days', red: 'CI failing', archived: 'Archived' }[r.health]}"></span>
      <span class="name">${esc(r.name)}</span>${badge}<span class="stats">${headline(r)}</span></div>
    ${sub ? `<div class="repo-sub">${sub}</div>` : ''}${detail}</div>`
}

const TABS = { plugin: '🧩 Plugins', app: '📦 Apps', other: '🗂 Other', follow: '⭐ Following' }

/** A release you haven't seen since you last opened Following. */
const isUnseen = f => Boolean(f.release) && (data.followSeen ?? {})[f.key] !== f.release.tag
// While you're on Following, keep showing what was new when you opened it.
let shownNew = new Set()

function renderTabs(repos) {
  const following = data.following ?? []
  const unseen = following.filter(isUnseen).length
  $('tabs').innerHTML = Object.entries(TABS)
    .map(([k, label]) => {
      const count = k === 'follow' ? following.length : repos.filter(r => r.kind === k).length
      const dot = k === 'follow' && unseen && tab !== 'follow' ? `<span class="new-dot" title="${plural(unseen, 'new release')}">${unseen}</span>` : ''
      return `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${label}<span class="count">${count}</span>${dot}</button>`
    })
    .join('')
}

// Install from Following, by "key|index|choice": { plan } while confirming, 'installing', { done }, or { error }.
const installState = new Map()
const isWindows = navigator.userAgent.includes('Windows')
const isMac = navigator.userAgent.includes('Mac')
const forThisPc = a => (isWindows ? /\.(exe|msi)$/i : isMac ? /\.(dmg|pkg)$/i : /\.(appimage|deb)$/i).test(a.name)
const OFFER_ICON = { marketplace: '🧩', plugin: '🧩', skill: '📜', app: '📦' }

function installLine(f, index, choice, label, description) {
  const id = `${f.key}|${index}|${choice ?? ''}`
  const st = installState.get(id)
  let right = `<button data-install="${esc(id)}">⬇ Install</button>`
  let below = ''
  if (st === 'installing') right = '<button disabled>Installing…</button>'
  else if (st?.done) {
    right = '<span class="ok">✓ Installed</span>'
    below = `<div class="install-note">${esc(st.done)}</div>`
  } else if (st?.error) {
    below = `<div class="install-note bad">${esc(st.error)}</div>`
  } else if (st?.plan) {
    right = ''
    below = `<div class="confirm">
      <div>This will run:</div>
      ${st.plan.steps.map(x => `<code>${esc(x)}</code>`).join('')}
      <div class="dim">Installs to ${esc(st.plan.where)}. It's code by <b>${esc(f.key.split('/')[0])}</b>: install only from people you trust.</div>
      <div class="btns"><button class="go" data-install-go="${esc(id)}">Install</button><button data-install-cancel="${esc(id)}">Cancel</button></div>
    </div>`
  }
  return `<div class="offer"><span class="offer-name">${label}${description ? `<span class="dim"> · ${esc(description)}</span>` : ''}</span>${right}</div>${below}`
}

/** What a followed repo offers: its plugins, skills, or this PC's installer. */
function installSection(f) {
  const lines = []
  for (const [index, o] of (f.install ?? []).entries()) {
    if (o.type === 'marketplace') for (const p of o.plugins) lines.push(installLine(f, index, p.name, `🧩 <b>${esc(p.name)}</b> plugin`, p.description))
    else if (o.type === 'plugin') lines.push(installLine(f, index, null, `🧩 <b>${esc(o.name)}</b> plugin`))
    else if (o.type === 'skill' && o.root) lines.push(installLine(f, index, null, `📜 <b>${esc(o.name)}</b> skill`))
    else if (o.type === 'skill') for (const sk of o.skills) lines.push(installLine(f, index, sk, `📜 <b>${esc(sk)}</b> skill`))
    else if (o.type === 'app') {
      const mine = o.assets.filter(forThisPc)
      for (const a of mine.slice(0, 2)) lines.push(`<div class="offer"><span class="offer-name">📦 <b>${esc(a.name)}</b></span><button data-open="${esc(a.url)}" title="Downloads in your browser">⬇ Download</button></div>`)
    }
  }
  return lines.length ? `<div class="install"><div class="install-title">Install</div>${lines.join('')}</div>` : ''
}

function followRow(f) {
  const isOpen = openRepos.has(f.key)
  const [owner, name] = f.key.split('/')
  const when = f.release?.at ?? f.pushedAt
  const sub = [
    f.release ? `<span class="tag">${esc(f.release.tag)}</span><span>${ago(f.release.at)}</span>` : `<span>pushed ${ago(f.pushedAt)}</span>`,
    f.language ? `<span><span class="lang" style="background:${esc(f.languageColor ?? '#888')}"></span> ${esc(f.language)}</span>` : '',
  ].filter(Boolean).join('<span class="sep">·</span>')
  const detail = isOpen
    ? `<div class="detail">${f.description ? `<div class="desc">${esc(f.description)}</div>` : ''}
        <div class="facts"><span>${f.starred ? '⭐ starred' : ''}${f.starred && f.watched ? ' · ' : ''}${f.watched ? '👁 watching: new releases notify you' : ''}</span></div>
        ${installSection(f)}
        <div class="btns">
          ${f.release ? `<button data-open="${esc(f.release.url)}">${esc(f.release.tag)} notes ↗</button>` : ''}
          <button data-open="${esc(f.url)}">Open on GitHub ↗</button>
        </div></div>`
    : ''
  return `<div class="repo${isOpen ? ' open' : ''}" data-repo="${esc(f.key)}" title="${esc(when ? `Last activity ${ago(when)}` : '')}">
    <div class="repo-top"><span class="dot ${f.isArchived ? 'archived' : 'follow'}"></span>
      <span class="name"><span class="owner">${esc(owner)}/</span>${esc(name)}</span>
      ${shownNew.has(f.key) ? '<span class="new">NEW</span>' : ''}
      <span class="stats">${[...new Set((f.install ?? []).map(o => o.type))].map(t => `<span title="Has a ${t} you can install">${OFFER_ICON[t]}</span>`).join('')}${f.watched ? '<span title="Watching">👁</span>' : ''}<span title="Stars">⭐ ${compact(f.stars)}</span></span></div>
    <div class="repo-sub">${sub}</div>${detail}</div>`
}

/** Marks Following as seen. Arriving on the tab starts a fresh NEW set; a sweep while you're there adds to it. */
function openFollowing(isArriving = true) {
  if (!data?.following) return
  const unseen = data.following.filter(isUnseen).map(f => f.key)
  shownNew = new Set([...(isArriving ? [] : shownNew), ...unseen])
  if (!unseen.length) return
  data.followSeen = { ...data.followSeen }
  for (const f of data.following) data.followSeen[f.key] = f.release?.tag ?? null
  window.radar.markFollowSeen()
}

function renderFollowing() {
  const at = f => Date.parse(f.release?.at ?? f.pushedAt ?? 0) || 0
  const list = [...(data.following ?? [])].sort((a, b) => shownNew.has(b.key) - shownNew.has(a.key) || at(b) - at(a))
  $('list').innerHTML = list.map(followRow).join('') || '<div class="dim pad">Star or watch repos on GitHub and they show up here.</div>'
}

function renderList(repos) {
  if (tab === 'follow') return renderFollowing()
  const errors = data.accounts.filter(a => a.error).map(a => `<div class="acct-error">⚠ ${esc(a.login)}: ${esc(a.error)}</div>`)
  const pushed = r => Date.parse(r.pushedAt ?? 0) || 0
  const list = repos.filter(r => (r.kind ?? 'other') === tab)
  if (tab === 'other') list.sort((a, b) => pushed(b) - pushed(a))
  else {
    const size = r => (r.kind === 'app' ? r.downloads : sum(entry(r)?.clones)) ?? 0
    list.sort((a, b) => week(b).now - week(a).now || size(b) - size(a) || pushed(b) - pushed(a))
  }
  $('list').innerHTML = errors.join('') + (list.map(repoRow).join('') || '<div class="dim pad">Nothing here yet.</div>')
}

function renderPrefs() {
  const hide = hidden()
  $('prefs').innerHTML =
    '<span class="prefs-title">Show</span>' +
    OPTIONS.map(([id, label]) => `<label><input type="checkbox" data-pref="${id}" ${hide.has(id) ? '' : 'checked'}/>${label}</label>`).join('')
}

function renderSwept() {
  $('swept').textContent = data?.fetchedAt ? `· swept ${ago(data.fetchedAt)}` : ''
}

function renderUpdate() {
  $('update').classList.toggle('hidden', !update)
  if (!update) return
  const v = esc(update.version)
  $('update').innerHTML = update.ready
    ? `<div class="news-head"><span>⬆ Repo Radar ${v} is ready</span><button id="update-go" class="update-go">Restart</button></div>`
    : `<div class="news-head"><span>⬆ Repo Radar ${v} is out</span><button id="update-go" class="update-go">Download</button></div>`
}

function render() {
  renderUpdate()
  $('error').classList.toggle('hidden', !error)
  $('error').textContent =
    error === 'no-auth' ? '⚠ No GitHub account found. Run "gh auth login" in a terminal, then sweep again.' : error ? `⚠ ${error}` : ''
  if (!data) return fit()
  const repos = allRepos()
  renderSwept()
  renderNeeds(repos)
  renderTiles(repos)
  renderTrend()
  if (data.accounts.length) {
    renderTabs(repos)
    renderList(repos)
  }
  if (!$('prefs').classList.contains('hidden')) renderPrefs()
  fit()
}

/** Sizes the window to the card. The list has its own cap and scrolls inside. */
function fit() {
  requestAnimationFrame(() => window.radar.fitHeight($('card').offsetHeight))
}

document.addEventListener('click', ev => {
  const t = ev.target
  if (t.closest('#update-go')) return window.radar.applyUpdate()
  if (t.closest('#digest-x')) {
    if (data) data.digest = null
    window.radar.dismissDigest()
    return render()
  }
  if (t.closest('#needs-more')) {
    needsOpen = !needsOpen
    return render()
  }
  const fixBtn = t.closest('[data-fix]')
  if (fixBtn) {
    const item = needs(allRepos()).find(i => i.id === fixBtn.dataset.fix)
    if (!item?.task || fixState.get(item.id) === 'opening') return
    fixState.set(item.id, 'opening')
    render()
    window.radar.fix(item.task).then(res => {
      fixState.set(item.id, res?.ok ? 'opened' : res?.why || 'Couldn’t open Claude')
      render()
      // The checkmark is a receipt, not a state: clear it after a bit so the button can be used again.
      setTimeout(() => {
        fixState.delete(item.id)
        render()
      }, 8000)
    })
    return
  }
  const doneBtn = t.closest('[data-done]')
  if (doneBtn) {
    const item = needs(allRepos()).find(i => i.id === doneBtn.dataset.done)
    if (item) setDone({ ...doneMap(), [item.id]: item.sig ?? '' })
    return
  }
  if (t.closest('#done-reset')) return setDone({})
  const closeBtn = t.closest('[data-close]')
  if (closeBtn) {
    const item = needs(allRepos()).find(i => i.id === closeBtn.dataset.close)
    const state = closeState.get(item?.id)
    if (!item || state === 'closing') return
    // First click arms it; it disarms on its own if the second never comes.
    if (state !== 'confirm') {
      closeState.set(item.id, 'confirm')
      render()
      setTimeout(() => {
        if (closeState.get(item.id) === 'confirm') closeState.delete(item.id), render()
      }, 4000)
      return
    }
    closeState.set(item.id, 'closing')
    render()
    window.radar.closeIssue(item.task).then(res => {
      if (res?.ok) closeState.delete(item.id)
      else {
        closeState.set(item.id, res?.why || 'Couldn’t close it')
        setTimeout(() => (closeState.delete(item.id), render()), 8000)
      }
      render()
    })
    return
  }
  const inst = t.closest('[data-install]')
  if (inst) {
    const id = inst.dataset.install
    const [key, index, choice] = id.split('|')
    window.radar.installPlan({ key, index: Number(index), choice: choice || null }).then(p => {
      installState.set(id, p.error ? { error: p.error } : { plan: p })
      render()
    })
    return
  }
  const cancel = t.closest('[data-install-cancel]')
  if (cancel) {
    installState.delete(cancel.dataset.installCancel)
    return render()
  }
  const go = t.closest('[data-install-go]')
  if (go) {
    const id = go.dataset.installGo
    const [key, index, choice] = id.split('|')
    installState.set(id, 'installing')
    render()
    window.radar.install({ key, index: Number(index), choice: choice || null }).then(res => {
      installState.set(id, res.ok ? { done: `Installed to ${res.where}. ${res.note}` } : { error: res.why })
      render()
    })
    return
  }
  const link = t.closest('[data-open]')
  if (link) return window.radar.open(link.dataset.open)
  const tabBtn = t.closest('[data-tab]')
  if (tabBtn) {
    tab = tabBtn.dataset.tab
    store.set('tab', tab)
    if (tab === 'follow') openFollowing()
    $('list').scrollTop = 0
    return render()
  }
  const repo = t.closest('[data-repo]')
  if (repo) {
    const key = repo.dataset.repo
    openRepos.has(key) ? openRepos.delete(key) : openRepos.add(key)
    return render()
  }
})
document.addEventListener('change', ev => {
  const id = ev.target.dataset?.pref
  if (!id || !data) return
  const hide = hidden()
  ev.target.checked ? hide.delete(id) : hide.add(id)
  data.prefs = { ...data.prefs, widgetHidden: [...hide] }
  window.radar.setPrefs({ widgetHidden: [...hide] })
  render()
})

$('refresh').onclick = () => window.radar.refresh()
$('hide').onclick = () => window.radar.hide()
$('close').onclick = () => window.radar.close()
$('settings').onclick = () => {
  $('prefs').classList.toggle('hidden')
  renderPrefs()
  fit()
}

window.radar.onData(d => {
  data = d
  if (tab === 'follow') openFollowing(false)
  if (d.accounts.length && error === 'no-auth') error = ''
  render()
})
window.radar.onScanning(on => {
  $('refresh').innerHTML = on ? '<span class="spin">↻</span>' : '↻'
  if (on) error = ''
})
window.radar.onUpdate(u => {
  update = u
  render()
})
window.radar.getUpdate().then(u => {
  update = u
  render()
})
window.radar.onError(msg => {
  error = msg
  render()
})
window.radar.get().then(d => {
  data = d
  if (tab === 'follow') openFollowing()
  render()
})
setInterval(renderSwept, 30 * 1000)
