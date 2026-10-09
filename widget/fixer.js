// "Fix with Claude": opens a Claude Code session in the repo's folder with the task written out.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const HOME = os.homedir()
// Where people keep their clones; each is searched two folders deep.
const ROOTS = ['Desktop', 'Documents', 'source/repos', 'repos', 'projects', 'code', 'dev', 'GitHub'].map(d => path.join(HOME, d))
const WORK = path.join(HOME, '.claude', 'repo-radar', 'work')

const GROUND_RULES =
  'This task comes from the Repo Radar widget. Work in a new branch. ' +
  'Before you push, comment on GitHub, merge, or publish a release, show me what you did and ask first.'

/** Titles come from strangers: keep them from breaking the command line (Windows Terminal splits on semicolons). */
const clean = s => String(s ?? '').replace(/[";\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)

/** The prompt for one Needs Attention item, built from the scan's own data. */
function promptFor(task, repo) {
  const key = `${repo.owner}/${repo.name}`
  switch (task.kind) {
    case 'ci':
      return `CI is failing on the default branch of ${key}. Find the failing run with gh run list and gh run view --log-failed, work out the cause, and fix it.`
    case 'assets':
      return `The latest release of ${key} (${clean(repo.release)}) is missing ${repo.missingAssets.map(clean).join(', ')}, which the release before it had. Find out why the build or release workflow left ${repo.missingAssets.length === 1 ? 'it' : 'them'} out, fix that, and get ${repo.missingAssets.length === 1 ? 'it' : 'them'} onto ${clean(repo.release)}.`
    case 'ship': {
      const n = repo.extras?.unreleased
      if (!n || !repo.release) return null
      const branch = clean(repo.defaultBranch ?? 'the default branch')
      return `${key} has ${n} commit${n === 1 ? '' : 's'} on ${branch} since its latest release ${clean(repo.release)}. Read what changed with git log ${clean(repo.release)}..${branch}, pick the right next version (semver: fixes are a patch, new features a minor), bump every version number in the repo (plugin.json, package.json, the marketplace copy if there is one), update the changelog, and draft the release notes. Get it all ready, then ask me before you tag, push, or publish the release.`
    }
    case 'alert': {
      const a = (repo.extras?.alerts ?? []).find(x => x.number === task.number)
      if (!a) return null
      return `Dependabot security alert #${a.number} on ${key}: ${clean(a.pkg)} (${clean(a.severity)}), ${clean(a.summary)}. Read it with gh api repos/${key}/dependabot/alerts/${a.number}, update the dependency to a version that fixes it, and run the tests to make sure nothing broke.`
    }
    case 'sync': {
      const x = repo.extras ?? {}
      const where = [
        repo.pluginVersion && `plugin.json says ${clean(repo.pluginVersion)}`,
        (x.marketVersion ?? repo.marketVersion) && `the copy in the ${clean(repo.marketName)} marketplace${repo.marketCopy ? ` (${clean(repo.marketCopy.repo)}, ${clean(repo.marketCopy.path)})` : ''} says ${clean(x.marketVersion ?? repo.marketVersion)}`,
        repo.release && `the latest release is ${clean(repo.release)}`,
      ].filter(Boolean)
      return `The versions of the ${key} plugin don't match: ${where.join(', ')}. Work out which one is right (check the changelog and the commits), then bring the others in line. That may mean updating the marketplace repo too. Ask me before you push to either repo or publish a release.`
    }
    case 'issue': {
      const i = (repo.issueList ?? []).find(x => x.number === task.number)
      if (!i) return null
      return `Fix issue #${i.number} on ${key}: ${clean(i.title)}. Read it in full with gh issue view ${i.number} --comments. If it reports a bug, reproduce it and fix it. If it asks for something new, make it.`
    }
    case 'pr': {
      const p = (repo.prList ?? []).find(x => x.number === task.number)
      if (!p) return null
      return `Review pull request #${p.number} on ${key}: ${clean(p.title)}. Read it with gh pr view ${p.number} and gh pr diff ${p.number}, check it out and test it if that helps, then give me your review. Do not merge it.`
    }
  }
  return null
}

/** Does this folder's git remote point at owner/name? */
function isCloneOf(dir, key) {
  try {
    const config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8')
    const want = key.toLowerCase()
    return [...config.matchAll(/url\s*=\s*(\S+)/g)].some(m => {
      const hit = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(m[1])
      return hit && hit[1].toLowerCase() === want
    })
  } catch {
    return false
  }
}

/** The repo's folder on this PC, remembered once found. */
function findLocal(key, remembered) {
  if (remembered[key] && isCloneOf(remembered[key], key)) return remembered[key]
  for (const root of ROOTS) {
    let level1
    try {
      level1 = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())
    } catch {
      continue
    }
    for (const d of level1) {
      const dir = path.join(root, d.name)
      if (isCloneOf(dir, key)) return dir
      let level2 = []
      try {
        level2 = fs.readdirSync(dir, { withFileTypes: true }).filter(x => x.isDirectory() && !x.name.startsWith('.') && x.name !== 'node_modules')
      } catch {}
      for (const x of level2) if (isCloneOf(path.join(dir, x.name), key)) return path.join(dir, x.name)
    }
  }
  return null
}

/** A POSIX shell word: single-quoted, so spaces and symbols in folder names survive. */
const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * The AppleScript that opens Terminal on the task: `cd <dir> && claude <prompt>`, every part quoted.
 * The shell line goes in as one AppleScript string; JSON's escaping (\" and \\) is AppleScript's too.
 */
const macScript = (dir, exe, prompt) =>
  `tell application "Terminal" to do script ${JSON.stringify(`cd ${shellQuote(dir)} && ${shellQuote(exe)} ${shellQuote(prompt)}`)}`

const claudeExe = () => {
  const local = path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return fs.existsSync(local) ? local : 'claude'
}

const hasWindowsTerminal = () => {
  try {
    execFileSync('where', ['wt'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Opens the session. Returns { ok, where } or { ok: false, why }.
 * `remembered` is the folder map kept in settings; it's updated in place.
 */
function launch(task, repo, remembered) {
  const key = `${repo.owner}/${repo.name}`
  let prompt = promptFor(task, repo)
  if (!prompt) return { ok: false, why: 'That item is gone; sweep again.' }
  let dir = findLocal(key, remembered)
  if (dir) remembered[key] = dir
  else {
    fs.mkdirSync(WORK, { recursive: true })
    dir = WORK
    prompt = `First clone ${key} here with gh repo clone ${key}, then work inside that folder. ${prompt}`
  }
  prompt = `${prompt} ${GROUND_RULES}`
  const exe = claudeExe()
  if (process.platform === 'win32') {
    const argv = hasWindowsTerminal()
      ? ['wt', ['-d', dir, '--title', `Claude: ${repo.name}`, exe, prompt]]
      : ['cmd', ['/c', 'start', `Claude: ${repo.name}`, '/d', dir, exe, prompt]]
    spawn(argv[0], argv[1], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', macScript(dir, exe, prompt), '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref()
  } else {
    return { ok: false, why: 'Opening a terminal isn’t supported on this system yet.' }
  }
  return { ok: true, where: dir === WORK ? 'a fresh clone' : dir }
}

module.exports = { launch, promptFor, macScript, shellQuote }
