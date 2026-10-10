// Health checks that need more than the sweep's GraphQL: Claude Code's own plugin validator,
// run on what's on GitHub, and README lines that name an older version than the latest release.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const CACHE = path.join(os.homedir(), '.claude', 'repo-radar', 'validate')
const SAFE = /^[\w.-]+$/

const run = (file, args, cwd) =>
  new Promise(resolve =>
    execFile(file, args, { cwd, windowsHide: true, timeout: 2 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout), err: String(stderr) }),
    ),
  )

const claudeExe = () => {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return fs.existsSync(local) ? local : 'claude'
}

/**
 * A shallow copy of the repo's default branch, kept up to date in the cache. It's GitHub's version
 * that users install, not whatever is in a local working copy. Returns the folder, or null.
 */
async function freshCopy(r, token) {
  if (!SAFE.test(r.owner) || !SAFE.test(r.name)) return null
  const dir = path.join(CACHE, r.owner, r.name)
  // The token rides in a header for this one command, never in the remote URL or on disk.
  const auth = ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
  const url = `https://github.com/${r.owner}/${r.name}.git`
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const c = await run('git', [...auth, 'clone', '--depth', '1', '--quiet', url, dir])
    return c.ok ? dir : null
  }
  const f = await run('git', [...auth, 'fetch', '--depth', '1', '--quiet', 'origin', 'HEAD'], dir)
  if (!f.ok) return null
  const reset = await run('git', ['reset', '--hard', '--quiet', 'FETCH_HEAD'], dir)
  return reset.ok ? dir : null
}

/** One `claude plugin validate --json` run: its errors as { where, message }, or null if it couldn't run. */
async function validateDir(dir, label) {
  const v = await run(claudeExe(), ['plugin', 'validate', dir, '--json'])
  let report
  try {
    report = JSON.parse(v.out)
  } catch {
    return null
  }
  const found = []
  const add = (file, list) => {
    for (const e of list ?? []) found.push({ where: `${label}${e.path ? ` (${e.path})` : ''}`, message: String(e.message ?? '').split('. ')[0] })
  }
  add(report.manifest?.file, report.manifest?.errors)
  for (const c of report.contents ?? []) add(c.file, c.errors)
  return found
}

/**
 * Validates a plugin or marketplace repo as GitHub has it, and each plugin a marketplace bundles.
 * Only runs when the default branch moved since the last check, so a quiet repo costs nothing.
 */
async function validate(r, token, x) {
  if (r.kind !== 'plugin' || !r.headOid) return
  if (x.validation?.oid === r.headOid) return
  const dir = await freshCopy(r, token)
  if (!dir) return
  // That clone or fetch came from this machine: it's one of ours, not an outside cloner.
  const today = new Date().toISOString().slice(0, 10)
  x.selfDays = { ...x.selfDays, [today]: true }
  const errors = await validateDir(dir, r.name)
  if (!errors) return
  // A marketplace keeps its plugins in folders of its own: check each one too.
  try {
    const market = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'))
    for (const p of market.plugins ?? []) {
      if (typeof p.source !== 'string' || !p.source.startsWith('./') || p.source === './') continue
      const sub = path.join(dir, p.source.slice(2))
      if (!sub.startsWith(dir) || !fs.existsSync(sub)) continue
      errors.push(...((await validateDir(sub, `${r.name}/${p.source.slice(2).replace(/\/$/, '')}`)) ?? []))
    }
  } catch {
    // not a marketplace
  }
  x.validation = { oid: r.headOid, errors, at: Date.now() }
}

const VERSION = /\bv?(\d+)\.(\d+)\.(\d+)\b/g
const LINK = /github\.com\/([\w.-]+)\/([\w.-]+)/g
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const parts = v => String(v).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(Number)

/**
 * README lines that name an older version than the latest release, of this repo or of a repo the
 * line links to (a marketplace README lists its plugins that way). A version is only matched to a repo
 * the line names or links, so "needs Node 18.0.0" never counts. Headings are skipped (changelog sections).
 */
function readmeDrift(text, self, releases) {
  const drift = []
  const ownNames = [self.name, self.name.replace(/[-_]/g, ' ')].map(s => s.toLowerCase())
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const versions = [...line.matchAll(VERSION)]
    if (!versions.length) continue
    const linked = [...line.matchAll(LINK)].map(m => `${m[1]}/${m[2].replace(/\.git$/, '')}`.toLowerCase()).filter(k => releases.has(k))
    const lower = line.toLowerCase()
    const target = linked[0] ?? (ownNames.some(n => lower.includes(n)) ? `${self.owner}/${self.name}`.toLowerCase() : null)
    const latest = target && releases.get(target)
    if (!latest) continue
    for (const v of versions) {
      const says = [Number(v[1]), Number(v[2]), Number(v[3])]
      if (cmp(says, parts(latest.tag)) < 0) {
        drift.push({ repo: latest.name, says: v[0], latest: latest.tag })
        break
      }
    }
  }
  // One note per repo is plenty.
  return [...new Map(drift.map(d => [d.repo, d])).values()]
}

module.exports = { validate, validateDir, readmeDrift }
