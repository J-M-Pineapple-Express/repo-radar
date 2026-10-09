const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('radar', {
  get: () => ipcRenderer.invoke('radar:get'),
  refresh: () => ipcRenderer.send('radar:refresh'),
  open: url => ipcRenderer.send('radar:open', url),
  dismissDigest: () => ipcRenderer.send('radar:dismissDigest'),
  setPrefs: prefs => ipcRenderer.send('radar:prefs', prefs),
  markFollowSeen: () => ipcRenderer.send('radar:followSeen'),
  fix: task => ipcRenderer.invoke('radar:fix', task),
  installPlan: req => ipcRenderer.invoke('radar:installPlan', req),
  install: req => ipcRenderer.invoke('radar:install', req),
  closeIssue: task => ipcRenderer.invoke('radar:closeIssue', task),
  onData: cb => ipcRenderer.on('radar:data', (_e, d) => cb(d)),
  onScanning: cb => ipcRenderer.on('radar:scanning', (_e, on) => cb(on)),
  onError: cb => ipcRenderer.on('radar:error', (_e, msg) => cb(msg)),
  fitHeight: h => ipcRenderer.send('widget:fit', h),
  hide: () => ipcRenderer.send('widget:hide'),
  close: () => ipcRenderer.send('widget:close'),
})
