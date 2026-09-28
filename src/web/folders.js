// Folder adapter over the browser's File System Access API (a
// FileSystemDirectoryHandle from showDirectoryPicker, or the origin-private
// file system). All paths are posix and relative to the picked folder.

export function handleFolder (root) {
  const split = (rel) => rel.split('/').filter(Boolean)

  async function dirFor (parts, create) {
    let d = root
    for (const p of parts) d = await d.getDirectoryHandle(p, { create })
    return d
  }

  async function fileHandle (rel, create = false) {
    const parts = split(rel)
    const name = parts.pop()
    const dir = await dirFor(parts, create)
    return dir.getFileHandle(name, { create })
  }

  const missing = (err) => err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')

  return {
    name: root.name,

    /** Every file, recursively. skipDir(relPath) prunes folders (node_modules, .git...). */
    async list (skipDir = () => false) {
      const out = []
      const visit = async (dir, prefix) => {
        for await (const [name, h] of dir.entries()) {
          const rel = prefix ? `${prefix}/${name}` : name
          if (h.kind === 'directory') {
            if (!skipDir(rel)) await visit(h, rel)
          } else {
            try {
              const f = await h.getFile()
              out.push({ path: rel, size: f.size, mtime: f.lastModified })
            } catch {} // vanished while listing
          }
        }
      }
      await visit(root, '')
      return out
    },

    async stat (rel) {
      try {
        const f = await (await fileHandle(rel)).getFile()
        return { size: f.size, mtime: f.lastModified }
      } catch (err) {
        if (err && err.name === 'TypeMismatchError') return { dir: true }
        if (missing(err)) return null
        throw err
      }
    },

    async read (rel) {
      try {
        const f = await (await fileHandle(rel)).getFile()
        return new Uint8Array(await f.arrayBuffer())
      } catch (err) {
        if (missing(err)) return null
        throw err
      }
    },

    async write (rel, bytes) {
      const h = await fileHandle(rel, true)
      const w = await h.createWritable()
      await w.write(bytes)
      await w.close()
    },

    /** Removes a file, then any folders it leaves empty. */
    async remove (rel) {
      const parts = split(rel)
      const name = parts.pop()
      try {
        const dir = await dirFor(parts, false)
        await dir.removeEntry(name)
      } catch (err) {
        if (!missing(err)) throw err
      }
      while (parts.length) {
        const last = parts.pop()
        try {
          const parent = await dirFor(parts, false)
          const dir = await parent.getDirectoryHandle(last)
          for await (const _ of dir.keys()) return // eslint-disable-line no-unused-vars
          await parent.removeEntry(last)
        } catch { return }
      }
    }
  }
}
