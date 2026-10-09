// Renders build/icon.html to build/icon.png (512px) for electron-builder: `npx electron build/make-icon.js`.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true, backgroundColor: '#00000000' })
  await win.loadFile(path.join(__dirname, 'icon.html'))
  await new Promise(r => setTimeout(r, 300))
  fs.writeFileSync(path.join(__dirname, 'icon.png'), (await win.capturePage({ x: 0, y: 0, width: 512, height: 512 })).resize({ width: 512, height: 512, quality: 'best' }).toPNG())
  app.quit()
})
