// Pure — no Next imports — so it can be unit-tested directly.
import { isValidOrgName } from './validate.js'

/** The metadata a new account starts with. A team sign-up carries its org's name until the org is made. */
export function signUpData ({ name, kind, orgName }) {
  const data = { name: String(name || '').trim().slice(0, 60) }
  if (kind !== 'team') return data
  const org = String(orgName || '').trim()
  return isValidOrgName(org) ? { ...data, org_name: org } : null
}
