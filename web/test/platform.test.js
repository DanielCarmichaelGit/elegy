import { test } from 'node:test'
import assert from 'node:assert/strict'
import { downloadFor, DOWNLOADS } from '../lib/platform.js'

test('the right download for each system', () => {
  assert.equal(downloadFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), DOWNLOADS.macArm, 'Macs report "Intel" even on Apple silicon; offer Apple silicon (most Macs now)')
  assert.equal(downloadFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), DOWNLOADS.windows)
  assert.equal(downloadFor('Mozilla/5.0 (X11; Linux x86_64)'), null)
  assert.equal(downloadFor(''), null)
  assert.match(DOWNLOADS.windows.href, /^https:\/\/github\.com\/DanielCarmichaelGit\/heyquilt\/releases\/latest\/download\/quilt-windows-x64\.exe$/)
})
