// Bundles the website (src/web/app.js and the sync engine it uses) into web/dist/app.js.
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
await build({
  entryPoints: [path.join(root, 'src/web/app.js')],
  outfile: path.join(root, 'web/dist/app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110', 'edge110'],
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info'
})
