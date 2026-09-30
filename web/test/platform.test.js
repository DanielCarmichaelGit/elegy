import { test } from 'node:test'
import assert from 'node:assert/strict'
import { downloadFor, pickDownloads, DOWNLOADS } from '../lib/platform.js'

test('the right download for each system', () => {
  assert.equal(downloadFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), DOWNLOADS.macArm, 'Macs report "Intel" even on Apple silicon; offer Apple silicon (most Macs now)')
  assert.equal(downloadFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), DOWNLOADS.windows)
  assert.equal(downloadFor('Mozilla/5.0 (X11; Linux x86_64)'), null)
  assert.equal(downloadFor(''), null)
  assert.match(DOWNLOADS.windows.href, /^https:\/\/github\.com\/DanielCarmichaelGit\/heyquilt\/releases\/latest\/download\/quilt-windows-x64\.exe$/)
})

test('pickDownloads: Mac, Apple silicon', () => {
  const { primary, others } = pickDownloads({ platform: 'macOS', architecture: 'arm' })
  assert.deepEqual(primary, [DOWNLOADS.macArm])
  assert.deepEqual(others, [DOWNLOADS.macIntel, DOWNLOADS.windows])
})

test('pickDownloads: Mac, Intel', () => {
  const { primary, others } = pickDownloads({ platform: 'macOS', architecture: 'x86' })
  assert.deepEqual(primary, [{ ...DOWNLOADS.macIntel, label: 'Download for Mac' }])
  assert.deepEqual(others, [DOWNLOADS.macArm, DOWNLOADS.windows])
})

test('pickDownloads: Windows', () => {
  const { primary, others } = pickDownloads({ platform: 'Windows', architecture: 'x86' })
  assert.deepEqual(primary, [DOWNLOADS.windows])
  assert.deepEqual(others, [DOWNLOADS.macArm])
})

test('pickDownloads: Linux (no button for it, so both)', () => {
  const { primary, others } = pickDownloads({ platform: 'Linux', architecture: 'x86' })
  assert.deepEqual(primary, [DOWNLOADS.macArm, DOWNLOADS.windows])
  assert.deepEqual(others, [DOWNLOADS.macIntel])
})

test('pickDownloads: unknown (empty input) falls back to both, and a UA string still helps', () => {
  assert.deepEqual(pickDownloads({}).primary, [DOWNLOADS.macArm, DOWNLOADS.windows])
  const { primary } = pickDownloads({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
  assert.deepEqual(primary, [DOWNLOADS.windows])
})
