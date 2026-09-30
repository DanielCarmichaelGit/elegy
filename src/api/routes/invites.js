// Joining an org: email invites (the API sends them) and domain join requests.
import { HttpError, needId } from '../http.js'
import { orgAccess } from '../org-access.js'
import { newToken, hashToken } from '../tokens.js'
import { emailDomain, isPublicDomain } from '../domains.js'
import { inviteEmail } from '../invite-email.js'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const GONE = {
  accepted: 'this invite was already used',
  cancelled: 'this invite was cancelled',
  expired: 'this invite has expired; ask for a new one'
}
// One address, no separators or angle brackets/quotes/parens a mail header could
// smuggle through, and exactly one '@' (so "a@x.com,b@y.com" can't sneak a second
// recipient past nodemailer). `emailDomain` still checks the part after '@' is a real domain.
const STRICT_EMAIL = /^[^\s@,;<>"()\\]+@[^\s@,;<>"()\\]+$/

export function inviteRoutes ({ store, user, now, site, mailer, log, limit, limitSend }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }
  const statusOf = (i) => (i.acceptedAt ? 'accepted' : i.cancelledAt ? 'cancelled' : i.expiresAt < now() ? 'expired' : 'pending')
  const inviteView = (i, role) => ({ id: i.id, email: i.email, roleId: i.roleId, role, expiresAt: i.expiresAt, createdAt: i.createdAt, expired: i.expiresAt < now() })

  // The domain of the caller's confirmed email, unless it belongs to a public mail provider.
  async function confirmedDomain (userId) {
    const mine = await store.userEmail(userId)
    const d = mine?.confirmed ? emailDomain(mine.email) : ''
    return d && !isPublicDomain(d) ? d : null
  }

  // A single, real-looking address; never a list, and never one a mail header could split.
  function cleanEmail (raw) {
    const email = String(raw || '').trim().toLowerCase()
    if (!email || email.length > 254 || !STRICT_EMAIL.test(email) || !emailDomain(email)) throw new HttpError(400, "that email doesn't look right")
    return email
  }

  // Someone already in the org, by their signed-in email — so an invite (or its
  // acceptance) can't hand a second membership, or a second role, to the same person.
  async function memberWithEmail (orgId, email) {
    for (const m of await store.listMembers(orgId)) {
      const e = await store.userEmail(m.userId)
      if (String(e?.email || '').toLowerCase() === email) return m
    }
    return null
  }

  // The link only ever travels by email; only its hash is stored.
  async function mail (a, invite, role, token) {
    const inviter = await store.profile(a.u.userId)
    const msg = inviteEmail({ orgName: a.org.name, inviterName: inviter?.name, roleName: role.name, link: `${site}/invite/${token}` })
    try {
      await mailer.send({ to: invite.email, ...msg })
    } catch (err) {
      log(`invite email failed: ${err?.stack || err?.message || err}`)
      throw new HttpError(502, "the invite was saved but the email didn't send; try Resend")
    }
  }

  async function openInvite (a, id) {
    const i = await store.inviteById(a.org.id, needId(id, 'invite'))
    if (!i || i.acceptedAt || i.cancelledAt) throw new HttpError(404, 'no such invite')
    return i
  }

  return [
    ['GET', /^\/v1\/orgs\/([^/]+)\/invites$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('invites', 'r')
      const roles = new Map((await store.listRoles(a.org.id)).map((r) => [r.id, r.name]))
      const [invites, requests] = await Promise.all([store.listInvites(a.org.id), store.listJoinRequests(a.org.id)])
      return {
        invites: invites.map((i) => inviteView(i, roles.get(i.roleId) || null)),
        requests: requests.map((r) => ({ id: r.id, userId: r.userId, name: r.name, email: r.email, createdAt: r.createdAt }))
      }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/invites$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('invites', 'c')
      limitSend(a.u.userId)
      const email = cleanEmail(body.email)
      const role = await a.assignable(body.roleId)
      if (await memberWithEmail(a.org.id, email)) throw new HttpError(409, 'that person is already a member')
      // One open invite per address: a new one replaces the old.
      for (const old of await store.listInvites(a.org.id)) if (old.email === email) await store.updateInvite(old.id, { cancelledAt: now() })
      const token = newToken('qi_')
      const invite = await store.createInvite({ orgId: a.org.id, email, roleId: role.id, tokenHash: hashToken(token), invitedBy: a.u.userId, expiresAt: now() + INVITE_TTL_MS })
      await mail(a, invite, role, token)
      return { invite: inviteView(invite, role.name) }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/invites\/([^/]+)\/resend$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('invites', 'u')
      limitSend(a.u.userId)
      const invite = await openInvite(a, id)
      const role = await store.roleById(a.org.id, invite.roleId)
      if (!role) throw new HttpError(404, 'no such role')
      if (!a.covers(role.grants)) throw new HttpError(403, 'you can only resend invites within your own permissions')
      const token = newToken('qi_')
      const fresh = await store.updateInvite(invite.id, { tokenHash: hashToken(token), expiresAt: now() + INVITE_TTL_MS })
      await mail(a, fresh, role, token)
      return { invite: inviteView(fresh, role.name) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/invites\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('invites', 'd')
      await store.updateInvite((await openInvite(a, id)).id, { cancelledAt: now() })
      return { ok: true }
    }],

    ['GET', /^\/v1\/invites\/([^/]+)$/, async (req, body, [token]) => {
      await user(req)
      limit(req)
      const invite = await store.inviteByToken(hashToken(token))
      if (!invite) throw new HttpError(404, 'no such invite')
      const org = await store.orgById(invite.orgId)
      const role = await store.roleById(invite.orgId, invite.roleId)
      return { org: { name: org.name, slug: org.slug }, email: invite.email, role: role?.name || null, status: statusOf(invite) }
    }],

    ['POST', /^\/v1\/invites\/accept$/, async (req, body) => {
      const u = await user(req)
      limit(req)
      const invite = await store.inviteByToken(hashToken(body.token))
      if (!invite) throw new HttpError(404, 'no such invite')
      const status = statusOf(invite)
      if (status !== 'pending') throw new HttpError(410, GONE[status])
      // Only the person it was sent to, once they've proved they own the address.
      const mine = await store.userEmail(u.userId)
      if (String(mine?.email || '').toLowerCase() !== invite.email) throw new HttpError(403, `this invite is for ${invite.email}; sign in with that address`)
      if (!mine.confirmed) throw new HttpError(403, 'confirm your email address first, then open the invite again')
      if (await store.memberOf(invite.orgId, u.userId)) throw new HttpError(409, "You're already in this org.")
      if (!await store.claimInvite(invite.id)) throw new HttpError(410, GONE.accepted)
      const org = await store.orgById(invite.orgId)
      await store.addMember({ orgId: org.id, userId: u.userId, roleId: invite.roleId })
      return { org: { name: org.name, slug: org.slug } }
    }],

    ['GET', /^\/v1\/orgs\/discover$/, async (req) => {
      const u = await user(req)
      const domain = await confirmedDomain(u.userId)
      if (!domain) return { domain: null, orgs: [] }
      const [orgs, mine, asked] = await Promise.all([store.orgsByDomain(domain), store.orgsForUser(u.userId), store.joinRequestsForUser(u.userId)])
      const joined = new Set(mine.map((o) => o.id))
      const pending = new Set(asked.filter((r) => r.status === 'pending').map((r) => r.orgId))
      return { domain, orgs: orgs.filter((o) => !joined.has(o.id)).map((o) => ({ name: o.name, slug: o.slug, requested: pending.has(o.id) })) }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/requests$/, async (req, body, [slug]) => {
      const u = await user(req)
      limit(req)
      const org = await store.orgBySlug(String(slug).toLowerCase())
      const domain = await confirmedDomain(u.userId)
      // One answer for a missing org and one you can't ask to join, so addresses can't be probed.
      if (!org || !org.domainRequests || !domain || org.domain !== domain) throw new HttpError(404, 'no such org')
      if (await store.memberOf(org.id, u.userId)) throw new HttpError(409, "you're already in this org")
      const mine = await store.userEmail(u.userId)
      const r = await store.createJoinRequest({ orgId: org.id, userId: u.userId, email: mine.email.toLowerCase() })
      return { request: { id: r.id, status: r.status } }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/requests\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      if (typeof body.approve !== 'boolean') throw new HttpError(400, 'approve must be true or false')
      const approve = body.approve
      // Approving is User invites: Create; denying is User invites: Delete.
      a.need('invites', approve ? 'c' : 'd')
      const r = await store.joinRequestById(a.org.id, needId(id, 'request'))
      if (!r || r.status !== 'pending') throw new HttpError(404, 'no such request')
      const role = approve ? await a.assignable(body.roleId) : null
      if (!await store.decideJoinRequest(r.id, { status: approve ? 'approved' : 'denied', decidedBy: a.u.userId })) throw new HttpError(404, 'no such request')
      if (approve) await store.addMember({ orgId: a.org.id, userId: r.userId, roleId: role.id })
      return { status: approve ? 'approved' : 'denied' }
    }]
  ]
}
