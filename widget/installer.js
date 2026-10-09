// Install from Following: plugins, marketplaces, mods and skills from repos you follow.
// The page names what to install; every command here is built from the scan's own data.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const SKILLS = path.join(os.homedir(), '.claude', 'skills')
const SAFE_NAME = /^[\w.-]{1,100}$/
const SAFE_KEY = /^[\w.-]+\/[\w.-]+$/

const claudeExe = () => {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return fs.existsSync(local) ? local : 'claude'
}

const run = (file, args, cwd) =>
  new Promise(resolve =>
    execFile(file, args, { cwd, windowsHide: true, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    ),
  )

/**
 * The steps for one install, for the confirm box and for running.
 * `choice` names one plugin of a marketplace, or one skill of a skills folder.
 * Returns { steps: [{ say, file, args }], where, note } or { error }.
 */
function plan(follow, offer, choice) {
  const key = follow?.key
  if (!SAFE_KEY.test(key ?? '')) return { error: 'That repo name looks wrong.' }
  const url = `https://github.com/${key}.git`
  if (offer.type === 'marketplace') {
    const plugin = offer.plugins.find(p => p.name === choice)
    if (!plugin || !SAFE_NAME.test(offer.name) || !SAFE_NAME.test(plugin.name)) return { error: 'Pick a plugin to install.' }
    return {
      steps: [
        { say: `claude plugin marketplace add ${key}`, file: claudeExe(), args: ['plugin', 'marketplace', 'add', key], okIf: /already|added|success/i },
        { say: `claude plugin install ${plugin.name}@${offer.name}`, file: claudeExe(), args: ['plugin', 'install', `${plugin.name}@${offer.name}`] },
      ],
      where: `Claude Code's plugins (${plugin.name}@${offer.name})`,
      note: 'It loads in new Claude Code sessions.',
    }
  }
  if (offer.type === 'plugin' || (offer.type === 'skill' && offer.root)) {
    const name = offer.name
    if (!SAFE_NAME.test(name)) return { error: 'That name looks wrong.' }
    const dest = path.join(SKILLS, name)
    if (fs.existsSync(dest)) return { error: `${dest} already exists. It may be installed already.` }
    return {
      steps: [{ say: `git clone --depth 1 ${url} "${dest}"`, file: 'git', args: ['clone', '--depth', '1', url, dest] }],
      where: dest,
      note: offer.type === 'plugin' ? 'Claude Code loads plugins from that folder in new sessions.' : 'Claude Code picks the skill up in new sessions.',
    }
  }
  if (offer.type === 'skill') {
    const skill = offer.skills.find(s => s === choice)
    if (!skill || !SAFE_NAME.test(skill)) return { error: 'Pick a skill to install.' }
    const dest = path.join(SKILLS, skill)
    if (fs.existsSync(dest)) return { error: `${dest} already exists. It may be installed already.` }
    const tmp = path.join(os.tmpdir(), `repo-radar-${process.pid}-${Date.now()}`)
    return {
      steps: [
        { say: `git clone --depth 1 ${url} (to a temporary folder)`, file: 'git', args: ['clone', '--depth', '1', url, tmp] },
        { say: `copy skills/${skill} to "${dest}"`, copy: { from: path.join(tmp, 'skills', skill), to: dest }, cleanup: tmp },
      ],
      where: dest,
      note: 'Claude Code picks the skill up in new sessions.',
    }
  }
  return { error: 'Nothing to install here.' }
}

/** Runs a plan's steps in order and stops at the first failure. */
async function install(planned) {
  const log = []
  for (const step of planned.steps) {
    if (step.copy) {
      try {
        if (!fs.existsSync(path.join(step.copy.from, 'SKILL.md'))) throw new Error('that skill folder has no SKILL.md')
        fs.mkdirSync(SKILLS, { recursive: true })
        fs.cpSync(step.copy.from, step.copy.to, { recursive: true })
        log.push(`✓ ${step.say}`)
      } catch (err) {
        return { ok: false, why: String(err.message ?? err), log }
      } finally {
        fs.rmSync(step.cleanup, { recursive: true, force: true })
      }
      continue
    }
    const r = await run(step.file, step.args)
    if (!r.ok && !(step.okIf && step.okIf.test(r.out))) return { ok: false, why: r.out.split('\n').slice(-3).join(' ') || 'It failed.', log }
    log.push(`✓ ${step.say}`)
  }
  return { ok: true, log, where: planned.where, note: planned.note }
}

module.exports = { plan, install }
