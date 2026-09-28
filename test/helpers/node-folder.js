// The web engine's folder adapter, backed by the real file system (for tests).
import fs from 'node:fs/promises'
import path from 'node:path'

export function nodeFolder (root) {
  const abs = (rel) => path.join(root, ...rel.split('/'))
  return {
    name: path.basename(root),
    async list (skipDir = () => false) {
      const out = []
      const visit = async (dirRel) => {
        let entries = []
        try { entries = await fs.readdir(path.join(root, dirRel), { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const rel = dirRel ? `${dirRel}/${e.name}` : e.name
          if (e.isDirectory()) { if (!skipDir(rel)) await visit(rel) } else if (e.isFile()) {
            const st = await fs.stat(abs(rel)).catch(() => null)
            if (st) out.push({ path: rel, size: st.size, mtime: st.mtimeMs })
          }
        }
      }
      await visit('')
      return out
    },
    async stat (rel) {
      const st = await fs.stat(abs(rel)).catch(() => null)
      if (!st) return null
      return st.isDirectory() ? { dir: true } : { size: st.size, mtime: st.mtimeMs }
    },
    async read (rel) {
      try { return new Uint8Array(await fs.readFile(abs(rel))) } catch { return null }
    },
    async write (rel, bytes) {
      await fs.mkdir(path.dirname(abs(rel)), { recursive: true })
      await fs.writeFile(abs(rel), bytes)
    },
    async remove (rel) {
      await fs.rm(abs(rel), { force: true })
    }
  }
}
