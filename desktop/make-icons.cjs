// Renders the desktop app's icons from SVG with transparent backgrounds.
// Run with: npx electron desktop/make-icons.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const jobs = [
  ['build/icon.svg', 'build/icon.png', 1024],
  ['icons/tray.svg', 'icons/trayTemplate.png', 22],
  ['icons/tray.svg', 'icons/trayTemplate@2x.png', 44],
  ['../assets/logo.svg', 'icons/tray-color.png', 32] // Windows/Linux taskbars can be light or dark
]

app.dock?.hide()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  for (const [src, out, size] of jobs) {
    const svg = fs.readFileSync(path.join(__dirname, src), 'utf8')
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((r) => setTimeout(r, 300))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    fs.writeFileSync(path.join(__dirname, out), img.resize({ width: size, height: size }).toPNG())
  }
  win.destroy()
  app.quit()
})
