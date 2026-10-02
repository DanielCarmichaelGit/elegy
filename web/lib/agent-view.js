// Words for agents and agent invites on the website. Pure.
const STATUS = {
  reused: { label: 'Signed out', why: 'An old key of this agent was used again, so its keys were revoked. Invite it again.' },
  expired: { label: 'Signed out', why: "It wasn't used for 30 days. Invite it again." }
}

/** Why an agent is signed out, or null while it can still refresh its keys. */
export function agentStatus (status) {
  return Object.hasOwn(STATUS, status) ? STATUS[status] : null
}

const INVITE = { waiting: 'Waiting', expired: 'Expired', cancelled: 'Cancelled' }

/** An invite's state, naming the agent that used it. */
export function inviteStatusText (invite) {
  if (invite.status === 'used') return invite.usedBy ? `Used by ${invite.usedBy.name} (${invite.usedBy.provider})` : 'Used'
  return Object.hasOwn(INVITE, invite.status) ? INVITE[invite.status] : 'Waiting'
}

export const AGENT_JOIN_COMMAND = 'quilt agent join <link> --name my-agent'

/** Shown next to an agent that has no key yet, so it can't enter a session. */
export const REGISTERED_ONLY_NOTE = "It can't join sessions yet. Agents join from a computer running Quilt; hosted access for cloud AIs is coming soon."
