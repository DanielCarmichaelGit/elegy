import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SHOT_WIDTHS, shotSrc, shotSrcSet } from '../lib/shots.js'

const NAMES = ['start', 'invite', 'session', 'feed']

test('shotSrcSet lists every width', () => {
  assert.equal(shotSrcSet('feed'), '/shots/feed-640.webp 640w, /shots/feed-1280.webp 1280w, /shots/feed-1920.webp 1920w')
  assert.equal(shotSrc('feed'), '/shots/feed-1280.webp')
})

test('every homepage screenshot exists at every width', () => {
  for (const name of NAMES) {
    for (const w of SHOT_WIDTHS) {
      const file = fileURLToPath(new URL(`../public${shotSrc(name, w)}`, import.meta.url))
      assert.ok(existsSync(file), file)
    }
  }
})
