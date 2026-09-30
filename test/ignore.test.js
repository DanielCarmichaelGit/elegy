import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadIgnore, isIgnored, walk } from '../src/fsutil.js'

function project (files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ignore-'))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

test('a .gitignore in a subfolder applies inside that folder', () => {
  const root = project({
    'web/.gitignore': '.next/\n*.log\n/out\nbuild/cache\n',
    'web/.next/server/chunk.js': 'x',
    'web/app/page.js': 'x',
    'web/app/debug.log': 'x',
    'web/out/index.html': 'x',
    'web/app/out/keep.txt': 'x',
    'web/build/cache/a.bin': 'x',
    'debug.log': 'x'
  })
  const ig = loadIgnore(root)
  assert.equal(isIgnored(ig, 'web/.next/server/chunk.js'), true)
  assert.equal(isIgnored(ig, 'web/app/debug.log'), true)
  assert.equal(isIgnored(ig, 'web/out/index.html'), true, 'a leading slash anchors to the subfolder')
  assert.equal(isIgnored(ig, 'web/app/out/keep.txt'), false, 'an anchored pattern does not match deeper')
  assert.equal(isIgnored(ig, 'web/build/cache/a.bin'), true, 'a pattern with a slash is relative to the subfolder')
  assert.equal(isIgnored(ig, 'web/app/page.js'), false)
  assert.equal(isIgnored(ig, 'debug.log'), false, 'a subfolder rule does not reach its parent')
  assert.deepEqual(walk(root, ig).sort(), ['debug.log', 'web/.gitignore', 'web/app/out/keep.txt', 'web/app/page.js'])
})

test('a subfolder .gitignore can re-include what its parent ignores', () => {
  const root = project({
    '.gitignore': '*.gen.js\n',
    'lib/.gitignore': '!keep.gen.js\n',
    'lib/keep.gen.js': 'x',
    'lib/drop.gen.js': 'x'
  })
  const ig = loadIgnore(root)
  assert.equal(isIgnored(ig, 'lib/keep.gen.js'), false)
  assert.equal(isIgnored(ig, 'lib/drop.gen.js'), true)
})

test('.gitignore files inside ignored folders are not read', () => {
  const root = project({
    'node_modules/pkg/.gitignore': '!*\n',
    'node_modules/pkg/index.js': 'x'
  })
  const ig = loadIgnore(root)
  assert.equal(isIgnored(ig, 'node_modules/pkg/index.js'), true)
})

test('build and cache folders are never synced, even without a .gitignore', () => {
  const root = project({ 'app/.next/cache/a.sst': 'x', 'app/.turbo/x': 'x', 'app/src/a.js': 'x' })
  const ig = loadIgnore(root)
  assert.deepEqual(walk(root, ig), ['app/src/a.js'])
})
