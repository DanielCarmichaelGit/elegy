// Access types and grants for the API's routes: finding a type (a built-in, or one of
// the owner's own) and what a grant comes to.
import { UUID } from './http.js'
import { builtinType, effectiveAccess, FALLBACK_TYPE } from '../session-access.js'

/** A built-in, or one of `ownerAccount`'s own types; null otherwise (someone else's, or none). */
export async function ownType (store, ownerAccount, typeId) {
  const id = String(typeId || '')
  const b = builtinType(id)
  if (b) return b
  if (!UUID.test(id)) return null
  const t = await store.accessTypeById(id)
  return t && t.ownerAccount === ownerAccount ? t : null
}

/** A grant's type: View only when its own is gone (deleted while this was read). */
export async function typeOfGrant (store, grant) {
  return builtinType(grant.typeId) || (UUID.test(grant.typeId) && await store.accessTypeById(grant.typeId)) || builtinType(FALLBACK_TYPE)
}

/** A grant as the owner sees it: its type's name and what it comes to. */
export async function grantView (store, grant) {
  const type = await typeOfGrant(store, grant)
  return { account: grant.account, typeId: type.id, typeName: type.name, tighten: grant.tighten || {}, access: effectiveAccess(type, grant.tighten), updatedAt: grant.updatedAt }
}
