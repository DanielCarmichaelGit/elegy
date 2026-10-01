// Files only you should read (this computer's sign-in, agents' keys): written
// atomically with mode 0600, and never through a symlink.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** True if `file` is a symlink (a missing file isn't). */
export function isSymlink (file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

/**
 * Writes JSON to `file`: a private temp file in the same folder, fsynced, then
 * renamed over the target. The rename replaces whatever is there without
 * following it, and a half-written file is never seen at the real path.
 */
export function writePrivateJson (file, data) {
  if (isSymlink(file)) throw new Error(`Refusing to write ${file}: it's a symlink`)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2))
    fs.fsyncSync(fd)
  } catch (err) {
    fs.closeSync(fd)
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
  fs.closeSync(fd)
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}
