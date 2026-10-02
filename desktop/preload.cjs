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
  },
  /** Calls `fn()` when "What's New in Quilt…" is chosen from the menu. */
  onReleaseNotes: (fn) => { ipcRenderer.on('release-notes', () => fn()) },
  /** Downloads and installs the newest Quilt, then restarts it. Rejects with a message when it can't. */
  installUpdate: () => ipcRenderer.invoke('install-update'),
  /** Calls `fn({ phase, received, total })` as an update downloads and installs. */
  onUpdateProgress: (fn) => { ipcRenderer.on('update-progress', (e, p) => fn(p)) }
})
