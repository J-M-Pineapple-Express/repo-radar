const { app, BrowserWindow, ipcMain, shell, Notification, screen } = require('electron')
const fs = require('fs')
const path = require('path')
const scanner = require('./scanner')
const fixer = require('./fixer')
const installer = require('./installer')

const WIDTH = 360
const REFRESH_MS = 10 * 60 * 1000
const NOTIFY_LIMIT = 3

let win = null
let scanning = false
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(next))
}

/** Keeps a saved position only when it still lands on a connected display. */
function savedBounds() {
  const b = loadSettings().bounds
  if (!b) return {}
  const onScreen = screen.getAllDisplays().some(d => {
    const a = d.workArea
    return b.x >= a.x - 20 && b.y >= a.y - 20 && b.x < a.x + a.width - 40 && b.y < a.y + a.height - 40
  })
  return onScreen ? { x: b.x, y: b.y } : {}
}

function createWidget() {
  win = new BrowserWindow({
    width: WIDTH,
    height: 520, // starting guess; the page fits it to its content
    ...savedBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    title: 'Repo Radar',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.loadFile(path.join(__dirname, 'public', 'index.html'))
  win.on('moved', () => {
    const { x, y } = win.getBounds()
    saveSettings({ bounds: { x, y } })
  })
  win.on('closed', () => (win = null))
  // Dev: RADAR_SHOT=file.png saves a picture of the widget once it has drawn;
  // RADAR_JS runs in the page first (say, clicking a tab).
  if (process.env.RADAR_SHOT) {
    win.webContents.on('did-finish-load', () =>
      setTimeout(async () => {
        if (process.env.RADAR_JS) await win.webContents.executeJavaScript(process.env.RADAR_JS)
        await new Promise(r => setTimeout(r, 400))
        fs.writeFileSync(process.env.RADAR_SHOT, (await win.capturePage()).toPNG())
      }, 3000),
    )
  }
}

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload)

// Updates come from this repo's GitHub releases. Windows downloads in the background and installs on restart.
// The Mac builds aren't signed, and macOS won't apply an unsigned update, so there the bar links the release.
const UPDATE_MS = 6 * 60 * 60 * 1000
const RELEASES = 'https://github.com/J-M-Pineapple-Express/repo-radar/releases/latest'
let update = null

const plain = html =>
  html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const firstSentence = s => {
  const one = s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s
  return one.length > 80 ? `${one.slice(0, 80).replace(/[\s,;:]+\S*$/, '')}…` : one
}

/**
 * Release notes as a few short lines: the first sentence of each bullet, newest release first.
 * With fullChangelog the updater hands over every release since this one, so a skipped version still counts.
 */
function notesSummary(notes, max = 4) {
  const items = []
  for (const html of (Array.isArray(notes) ? notes.map(n => n.note) : [notes]).map(h => String(h ?? ''))) {
    const bullets = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => plain(m[1]))
    const para = plain(html.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '')
    items.push(...(bullets.length ? bullets : para ? [para] : []).map(firstSentence))
  }
  return { items: items.slice(0, max), more: Math.max(0, items.length - max) }
}

function watchUpdates() {
  if (!app.isPackaged && !process.env.RADAR_UPDATE_TEST) return
  const { autoUpdater } = require('electron-updater')
  const canInstall = process.platform === 'win32'
  autoUpdater.autoDownload = canInstall
  autoUpdater.autoInstallOnAppQuit = canInstall
  autoUpdater.fullChangelog = true
  if (process.env.RADAR_UPDATE_TEST) {
    // Dev: RADAR_UPDATE_TEST=0.1.0 pretends to be that version, to try the check against the real releases.
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = console
    autoUpdater.setFeedURL({ provider: 'github', owner: 'J-M-Pineapple-Express', repo: 'repo-radar' })
    autoUpdater.currentVersion = new autoUpdater.currentVersion.constructor(process.env.RADAR_UPDATE_TEST)
  }
  // The summary is kept in settings too, for the "Updated to" card once the new version starts.
  const tell = (info, ready) => {
    const notes = { version: info.version, ...notesSummary(info.releaseNotes) }
    saveSettings({ updatedNotes: notes })
    send('radar:update', (update = { ...notes, ready }))
  }
  autoUpdater.on('update-available', info => !canInstall && tell(info, false))
  autoUpdater.on('update-downloaded', info => tell(info, true))
  autoUpdater.on('error', () => {}) // offline or rate-limited: try again next time
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, UPDATE_MS)
}

function notify(news) {
  if (!Notification.isSupported()) return
  for (const line of news.slice(0, NOTIFY_LIMIT)) new Notification({ title: '📡 Repo Radar', body: line }).show()
  if (news.length > NOTIFY_LIMIT) new Notification({ title: '📡 Repo Radar', body: `+${news.length - NOTIFY_LIMIT} more updates` }).show()
}

async function sweep(force = false) {
  if (scanning) return
  scanning = true
  send('radar:scanning', true)
  try {
    const { news, error } = await scanner.scan({ force })
    if (error) send('radar:error', error)
    notify(news)
  } catch (err) {
    send('radar:error', String(err))
  } finally {
    scanning = false
    send('radar:scanning', false)
  }
}

// The mod may write data.json too, so redraw on any change, whoever made it.
function watchData() {
  const dir = path.dirname(scanner.DATA)
  fs.mkdirSync(dir, { recursive: true })
  let timer = null
  fs.watch(dir, (_e, file) => {
    if (file !== path.basename(scanner.DATA)) return
    clearTimeout(timer)
    timer = setTimeout(() => send('radar:data', scanner.load()), 150)
  })
}

ipcMain.handle('radar:get', () => scanner.load())
ipcMain.handle('radar:version', () => app.getVersion())
ipcMain.handle('radar:getUpdate', () => update)
// What the update that just installed brought, until the card is dismissed.
ipcMain.handle('radar:getUpdated', () => {
  const notes = loadSettings().updatedNotes
  return notes?.version === app.getVersion() ? notes : null
})
ipcMain.on('radar:dismissUpdated', () => saveSettings({ updatedNotes: null }))
ipcMain.on('radar:applyUpdate', () => {
  if (update?.ready) require('electron-updater').autoUpdater.quitAndInstall(true, true)
  else shell.openExternal(RELEASES)
})
ipcMain.on('radar:refresh', () => sweep(true))
ipcMain.on('radar:open', (_e, url) => /^https:\/\//.test(url) && shell.openExternal(url))
ipcMain.on('radar:dismissDigest', () => {
  const data = scanner.load()
  data.digest = null
  scanner.save(data)
})
// Fix with Claude: the page names the item; the task itself is built here from the scan's data.
ipcMain.handle('radar:fix', (_e, task) => {
  const data = scanner.load()
  const found = data.accounts.flatMap(a => a.repos).find(r => `${r.owner}/${r.name}` === task?.repo)
  if (!found) return { ok: false, why: 'That repo isn’t in the last sweep.' }
  const repo = { ...found, extras: data.extras?.[task.repo] ?? {} }
  const remembered = loadSettings().localRepos ?? {}
  try {
    const result = fixer.launch(task, repo, remembered)
    saveSettings({ localRepos: remembered })
    return result
  } catch (err) {
    return { ok: false, why: String(err.message ?? err) }
  }
})

// Close an issue from Needs Attention. The page asks twice before calling this.
ipcMain.handle('radar:closeIssue', async (_e, task) => {
  if (task?.kind !== 'issue' || typeof task.repo !== 'string' || !Number.isInteger(task.number)) return { ok: false, why: 'Not an issue.' }
  try {
    return await scanner.closeIssue(task.repo, task.number)
  } catch (err) {
    return { ok: false, why: String(err.message ?? err) }
  }
})

// Install from Following. The page sends { key, index, choice }; the offer itself comes from data.json.
const offerFor = req => {
  const follow = (scanner.load().following ?? []).find(f => f.key === req?.key)
  return { follow, offer: follow?.install?.[req?.index] }
}
ipcMain.handle('radar:installPlan', (_e, req) => {
  const { follow, offer } = offerFor(req)
  if (!offer) return { error: 'That isn’t in the last sweep.' }
  const p = installer.plan(follow, offer, req.choice)
  return p.error ? p : { steps: p.steps.map(s => s.say), where: p.where, note: p.note }
})
ipcMain.handle('radar:install', async (_e, req) => {
  const { follow, offer } = offerFor(req)
  if (!offer) return { ok: false, why: 'That isn’t in the last sweep.' }
  const p = installer.plan(follow, offer, req.choice)
  if (p.error) return { ok: false, why: p.error }
  return installer.install(p)
})

// Opening Following marks every release there as seen.
ipcMain.on('radar:followSeen', () => {
  const data = scanner.load()
  data.followSeen = { ...data.followSeen }
  for (const f of data.following ?? []) data.followSeen[f.key] = f.release?.tag ?? null
  scanner.save(data)
})
ipcMain.on('radar:prefs', (_e, prefs) => {
  const data = scanner.load()
  data.prefs = { ...data.prefs, ...prefs }
  scanner.save(data)
})
ipcMain.on('widget:fit', (_e, h) => {
  if (!win) return
  const max = screen.getDisplayMatching(win.getBounds()).workArea.height - 40
  win.setContentSize(WIDTH, Math.min(Math.ceil(h), max))
})
ipcMain.on('widget:hide', () => win?.minimize())
ipcMain.on('widget:close', () => app.quit())

// One widget at a time: launching it again (say from /repos widget) brings this one forward.
// The second copy quits before it makes a window or sweeps.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(() => {
    createWidget()
    watchData()
    sweep()
    setInterval(() => sweep(), REFRESH_MS)
    watchUpdates()
  })
  app.on('window-all-closed', () => app.quit())
}
