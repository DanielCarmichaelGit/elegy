import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installedEditors, openCommand } from '../src/editors.js'

const mac = (apps) => ({ platform: 'darwin', home: '/Users/me', exists: (p) => apps.includes(p) })

test('only installed apps are offered, from /Applications or ~/Applications', () => {
  const opts = mac(['/Applications/Claude.app', '/Users/me/Applications/Cursor.app'])
  assert.deepEqual(installedEditors(opts).map((e) => e.id), ['claude', 'cursor'])
})

test('Claude opens a new Claude Code session on the folder', () => {
  const [file, args] = openCommand('claude', '/Users/me/My Project', mac(['/Applications/Claude.app']))
  assert.equal(file, 'open')
  assert.deepEqual(args, ['claude://code/new?folder=%2FUsers%2Fme%2FMy%20Project'])
})

test('other apps get the folder handed to them', () => {
  const [file, args] = openCommand('cursor', '/Users/me/p', mac(['/Applications/Cursor.app']))
  assert.equal(file, 'open')
  assert.deepEqual(args, ['-a', '/Applications/Cursor.app', '/Users/me/p'])
})

test('unknown or missing apps are refused', () => {
  assert.throws(() => openCommand('rm -rf', '/x', mac([])), /Unknown app/)
  assert.throws(() => openCommand('zed', '/x', mac([])), /isn't installed/)
})
