// No em dashes in user-facing copy. A simple scan: strip `//` line comments, then look for "—"
// anywhere else in the file (string literals, JSX text, template literals).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const roots = ['app', 'components'].map((d) => fileURLToPath(new URL(`../${d}`, import.meta.url)))

function * files (dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) yield * files(p)
    else if (/\.(js|jsx)$/.test(name)) yield p
  }
}

function stripLineComments (src) {
  return src.split('\n').map((line) => {
    const i = line.indexOf('//')
    return i === -1 ? line : line.slice(0, i)
  }).join('\n')
}

test('no em dashes in web/app or web/components outside comments', () => {
  const offenders = []
  for (const root of roots) {
    for (const file of files(root)) {
      const code = stripLineComments(readFileSync(file, 'utf8'))
      if (code.includes('—')) offenders.push(file)
    }
  }
  assert.deepEqual(offenders, [], `em dash ("—") found in: ${offenders.join(', ')}`)
})
