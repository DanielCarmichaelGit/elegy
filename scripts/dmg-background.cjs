// Renders scripts/dmg-background.html at 2x to desktop/build/background@2x.png.
// Run: npx electron scripts/dmg-background.cjs && sips -Z 660 desktop/build/background@2x.png --out desktop/build/background.png
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const out = path.join(__dirname, '..', 'desktop', 'build')
  for (const [zoom, name] of [[2, 'background@2x.png']]) {
    const win = new BrowserWindow({ width: 660 * zoom, height: 420 * zoom, show: false, useContentSize: true, webPreferences: { offscreen: true } })
    await win.loadFile(path.join(__dirname, 'dmg-background.html'))
    win.webContents.setZoomFactor(zoom)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(out, name), img.toPNG())
    console.log(name, img.getSize())
    win.destroy()
  }
  app.quit()
})
