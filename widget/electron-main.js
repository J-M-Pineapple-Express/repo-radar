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
  })
  app.on('window-all-closed', () => app.quit())
}
