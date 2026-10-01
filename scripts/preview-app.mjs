// For Claude Code's preview pane: opens the Quilt app that's already running
// (the desktop app first) instead of starting a second copy, which would fight
// it over the same session folders. Serves only on 127.0.0.1.
// Usage: node scripts/preview-app.mjs [port]   (default 7499)
import http from 'node:http'
import { runningAppUrl } from '../src/procs.js'

const port = Number(process.argv[2] || 7499)

const waiting = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Quilt</title>
<body style="font-family: system-ui, sans-serif; background: #f4efe6; color: #211d18; display: grid; place-items: center; height: 100vh; margin: 0">
<div style="text-align: center"><h2>Open the Quilt app first</h2><p>This page opens it here as soon as it's running.</p></div>`

http.createServer((req, res) => {
  const url = runningAppUrl()
  if (url) {
    res.writeHead(302, { location: url, 'cache-control': 'no-store' })
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(waiting)
}).listen(port, '127.0.0.1', () => console.log(`Quilt preview on http://127.0.0.1:${port}`))
