// Pure — no Next imports — so it can be unit-tested directly.
import { isValidOrgName } from './validate.js'

/** The metadata a personal sign-up starts with. */
export function signUpData ({ name }) {
  return { name: String(name || '').trim().slice(0, 60) }
}

/** The metadata an org sign-up starts with. The org itself is made the first
 * time this person signs in (see FirstOrg / createFirstOrg). */
export function orgSignUpData ({ name, orgName }) {
  const org = String(orgName || '').trim()
  if (!isValidOrgName(org)) return null
  return { name: String(name || '').trim().slice(0, 60), org_name: org, account: 'org' }
}
