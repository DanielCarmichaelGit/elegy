// Gives the app page a few desktop-only abilities: a native folder picker
// and invite links that open the app.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('quiltDesktop', {
  platform: process.platform,
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current || ''),
  /** Calls `fn(link)` for each invite link opened, including one that launched the app. */
  onInvite: (fn) => {
    ipcRenderer.on('invite', (e, link) => fn(link))
    ipcRenderer.invoke('ready').then((link) => { if (link) fn(link) })
  }
})
