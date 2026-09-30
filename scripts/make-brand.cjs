// Builds the brand kit (brand/logo, brand/one-colour, brand/web) and the desktop app's icon
// sources (assets/logo.svg, desktop/build/icon.svg, desktop/icons/tray.svg) from one drawing:
// a Q pieced from four pastel patches whose tail is a thread that waves under "uilt" and ends
// in a sharp point. The same geometry as web/lib/mark.js and src/ui/mark.js.
// Run with: npx electron scripts/make-brand.cjs   (then: npx electron desktop/make-icons.cjs)
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const C = {
  peach: '#FFB8A3', butter: '#FFE08A', mint: '#A8E6CF', lilac: '#C9B8FF',
  ink: '#2B2A38', warm: '#FFF8F3', blush: '#FDEEE6', paper: '#F4F2FA', rust: '#C24F33'
}

// The outlined "uilt" lives in the site's mark, so there's one copy of it.
const UILT = fs.readFileSync(path.join(ROOT, 'web/lib/mark.js'), 'utf8').match(/const UILT = '([^']+)'/)[1]
const UILT_AT = 'matrix(.5525 0 0 .5525 26.5 -13.5)'
const THREAD_LONG = 'M73 86C81 102 94 110 112 110C132 110 140 104 160 104C180 104 188 111 208 111C228 111 236 105 256 105C264 105 270 106 276 107'
const TIP_LONG = 'M276.4 104.5Q288 106.4 300.6 111.1Q287.4 111.5 275.6 109.5Z'
const THREAD_SHORT = 'M73 86C79 97 86 104 95 107.6'
const TIP_SHORT = 'M95.9 105.3Q106.1 109.4 113.6 115Q104.3 114 94.1 109.9Z'
const VB = { word: [8, 18, 296, 98], sym: [8, 18, 108, 100], small: [4, 4, 100, 100] }

// Quarter arcs of the ring (centre 52,62, r 35), clockwise from 12 o'clock.
function arc (i) {
  const pt = (deg) => { const a = (deg - 90) * Math.PI / 180; return `${(52 + 35 * Math.cos(a)).toFixed(2)} ${(62 + 35 * Math.sin(a)).toFixed(2)}` }
  return `M${pt(i * 90)}A35 35 0 0 1 ${pt(i * 90 + 90)}`
}
const PATCHES = [C.peach, C.butter, C.mint, C.lilac]

/** The mark's shapes. mono: one colour for everything; else pastel patches with ink/thread colours. */
function body ({ word, mono, ink = C.ink, thread = C.ink }) {
  const ring = mono
    ? `<circle cx="52" cy="62" r="35" fill="none" stroke="${mono}" stroke-width="15"/>`
    : PATCHES.map((c, i) => `<path d="${arc(i)}" fill="none" stroke="${c}" stroke-width="15"/>`).join('')
  const t = mono || thread
  const line = `<path d="${word ? THREAD_LONG : THREAD_SHORT}" fill="none" stroke="${t}" stroke-width="5" stroke-linecap="round"/><path d="${word ? TIP_LONG : TIP_SHORT}" fill="${t}"/>`
  const text = word ? `<path transform="${UILT_AT}" fill="${mono || ink}" d="${UILT}"/>` : ''
  return ring + line + text
}
// The small cut: no patches, no wave, a straight tail. For 16-32 px.
const small = (fill) => `<circle cx="48" cy="48" r="32" fill="none" stroke="${fill}" stroke-width="16"/><path d="M66 70L92 96" stroke="${fill}" stroke-width="12" stroke-linecap="round"/>`

function svg (vb, inner, { w, h } = {}) {
  const [, , vw, vh] = vb
  const size = w ? ` width="${w}" height="${h}"` : ` width="${vw}" height="${vh}"`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}"${size} role="img"><title>Quilt</title>${inner}</svg>\n`
}
// A square tile with the symbol on it, centred optically: on a point just below and right of
// the ring's centre, so the tail doesn't pull the Q off to one side. span: ring width / tile.
function tile ({ bg, fg = 'sym', dark = false, rx = 56, span = 0.46, size = 256, margin = 0 }) {
  const t = size - margin * 2
  const [ringW, cx, cy] = fg === 'small' ? [80, 52, 52] : [85, 58, 68]
  const s = (t * span) / ringW
  const tx = margin + t / 2 - cx * s
  const ty = margin + t / 2 - cy * s
  const inner = fg === 'small' ? small(dark ? C.paper : C.ink) : body({ word: false, thread: dark ? C.peach : C.ink })
  return `<rect x="${margin}" y="${margin}" width="${t}" height="${t}" rx="${rx}" fill="${bg}"/><g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">${inner}</g>`
}

const out = {}
const put = (rel, text) => { out[rel] = text; fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true }); fs.writeFileSync(path.join(ROOT, rel), text) }

// ---- logo ----
put('brand/logo/quilt-horizontal.svg', svg(VB.word, body({ word: true })))
put('brand/logo/quilt-horizontal-dark.svg', svg(VB.word, body({ word: true, ink: C.paper, thread: C.peach })))
put('brand/logo/quilt-symbol.svg', svg(VB.sym, body({ word: false })))
put('brand/logo/quilt-symbol-dark.svg', svg(VB.sym, body({ word: false, thread: C.peach })))
put('brand/logo/quilt-symbol-small.svg', svg(VB.small, small(C.ink)))
put('brand/logo/quilt-icon.svg', svg([0, 0, 256, 256], tile({ bg: C.blush })))
put('brand/logo/quilt-icon-dark.svg', svg([0, 0, 256, 256], tile({ bg: C.ink, dark: true })))
put('brand/logo/quilt-icon-maskable.svg', svg([0, 0, 256, 256], tile({ bg: C.blush, rx: 0, span: 0.4 })))
fs.rmSync(path.join(ROOT, 'brand/logo/quilt-stacked.svg'), { force: true })

// ---- one colour ----
for (const [name, col] of [['black', '#000000'], ['white', '#FFFFFF'], ['mono-c24f33', C.rust]]) {
  put(`brand/one-colour/quilt-horizontal-${name}.svg`, svg(VB.word, body({ word: true, mono: col })))
  put(`brand/one-colour/quilt-symbol-${name}.svg`, svg(VB.sym, body({ word: false, mono: col })))
}
for (const f of ['quilt-horizontal-mono-c4472f.svg', 'quilt-horizontal-mono-c4472f-1200.png', 'quilt-symbol-mono-c4472f.svg', 'quilt-symbol-mono-c4472f-512.png']) {
  fs.rmSync(path.join(ROOT, 'brand/one-colour', f), { force: true })
}

// ---- web ----
put('brand/web/favicon.svg', svg(VB.small, small(C.ink)))
const fullTile = tile({ bg: C.blush, rx: 0, span: 0.5 })
put('brand/web/site.webmanifest', JSON.stringify({
  name: 'Quilt',
  short_name: 'Quilt',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ],
  theme_color: C.warm,
  background_color: C.warm,
  display: 'standalone'
}, null, 2) + '\n')
put('brand/web/head-snippet.html', `<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="${C.warm}">
`)

// ---- desktop app sources ----
// macOS icon grid: an 824/1024 tile, centred, with room for the system shadow.
put('desktop/build/icon.svg', svg([0, 0, 256, 256], tile({ bg: C.blush, margin: 25, rx: 45 })))
put('assets/logo.svg', svg([0, 0, 256, 256], tile({ bg: C.blush })))
put('desktop/icons/tray.svg', svg(VB.small, small('#000'), { w: 22, h: 22 }))

// ---- PNG exports ----
const PNG = [
  ['brand/logo/quilt-icon.svg', 'brand/web/icon-512.png', 512, 512],
  ['brand/logo/quilt-icon.svg', 'brand/web/icon-192.png', 192, 192],
  ['brand/logo/quilt-icon-maskable.svg', 'brand/web/maskable-512.png', 512, 512],
  [null, 'brand/web/apple-touch-icon.png', 180, 180, svg([0, 0, 256, 256], fullTile)],
  ['brand/web/favicon.svg', 'brand/web/favicon-48.png', 48, 48],
  ['brand/web/favicon.svg', 'brand/web/favicon-32.png', 32, 32],
  ['brand/web/favicon.svg', 'brand/web/favicon-16.png', 16, 16]
]
for (const name of ['black', 'white', 'mono-c24f33']) {
  PNG.push([`brand/one-colour/quilt-horizontal-${name}.svg`, `brand/one-colour/quilt-horizontal-${name}-1200.png`, 1200, Math.round(1200 * VB.word[3] / VB.word[2])])
  PNG.push([`brand/one-colour/quilt-symbol-${name}.svg`, `brand/one-colour/quilt-symbol-${name}-512.png`, 512, Math.round(512 * VB.sym[3] / VB.sym[2])])
}

// A .ico holding PNG images (supported everywhere since Vista).
function ico (pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4)
  let offset = head.length
  pngs.forEach(([size, buf], i) => {
    const e = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1)
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12)
    offset += buf.length
  })
  return Buffer.concat([head, ...pngs.map(([, b]) => b)])
}

app.dock?.hide()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 1200, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  for (const [src, dest, w, h, inline] of PNG) {
    const text = inline || fs.readFileSync(path.join(ROOT, src), 'utf8')
    const sized = text.replace(/ width="[^"]*" height="[^"]*"/, ` width="${w}" height="${h}"`)
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${sized}</body></html>`
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((r) => setTimeout(r, 250))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h })
    fs.writeFileSync(path.join(ROOT, dest), img.resize({ width: w, height: h, quality: 'best' }).toPNG())
  }
  win.destroy()
  const pngs = [16, 32, 48].map((s) => [s, fs.readFileSync(path.join(ROOT, `brand/web/favicon-${s}.png`))])
  fs.writeFileSync(path.join(ROOT, 'brand/web/favicon.ico'), ico(pngs))
  console.log(`wrote ${Object.keys(out).length} SVGs, ${PNG.length} PNGs and favicon.ico`)
  app.quit()
})
