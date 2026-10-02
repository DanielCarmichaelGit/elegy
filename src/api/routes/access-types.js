// Access types: reusable sets of what someone may do in a session (edit or view, which
// folders, and whether they may post). Every account has the two built-ins, which can't
// be changed, and up to 50 of its own.
import { HttpError, UUID } from '../http.js'
import { BUILTIN_TYPES, builtinType, cleanTypeFields, MAX_TYPES } from '../../session-access.js'

const NO_TYPE = 'no such access type'
const BUILT_IN = "Built-in access types can't be changed or deleted."

export const typeView = (t) => ({ id: t.id, name: t.name, files: t.files, folders: [...(t.folders || [])], talk: t.talk !== false, builtin: !!t.builtin, ...(t.builtin ? {} : { createdAt: t.createdAt, updatedAt: t.updatedAt }) })

export function accessTypeRoutes ({ store, person }) {
  const me = async (req) => `person:${(await person(req)).userId}`
  const fields = (body, opts) => {
    try { return cleanTypeFields(body, opts) } catch (err) { throw new HttpError(400, err.message) }
  }
  /** One of my own types (a built-in is 403, anything else 404). */
  async function mine (account, id) {
    if (builtinType(id)) throw new HttpError(403, BUILT_IN)
    const t = UUID.test(id) ? await store.accessTypeById(id) : null
    if (!t || t.ownerAccount !== account) throw new HttpError(404, NO_TYPE)
    return t
  }

  return [
    ['GET', /^\/v1\/access-types$/, async (req) => {
      const account = await me(req)
      return { types: [...BUILTIN_TYPES, ...await store.listAccessTypes(account)].map(typeView) }
    }],

    ['POST', /^\/v1\/access-types$/, async (req, body) => {
      const account = await me(req)
      const f = fields(body)
      if ((await store.listAccessTypes(account)).length >= MAX_TYPES) throw new HttpError(409, 'You can have at most 50 access types. Delete one first.')
      return { type: typeView(await store.createAccessType({ ownerAccount: account, ...f })) }
    }],

    ['PUT', /^\/v1\/access-types\/([^/]+)$/, async (req, body, [id]) => {
      const account = await me(req)
      const f = fields(body, { partial: true })
      const t = await mine(account, id)
      if (!Object.keys(f).length) return { type: typeView(t) }
      return { type: typeView(await store.updateAccessType(t.id, f)) }
    }],

    // Grants that used it fall back to View only.
    ['DELETE', /^\/v1\/access-types\/([^/]+)$/, async (req, body, [id]) => {
      const account = await me(req)
      const t = await mine(account, id)
      if (!await store.deleteAccessType(t.id, account)) throw new HttpError(404, NO_TYPE)
      return { ok: true }
    }]
  ]
}
