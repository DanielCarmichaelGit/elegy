// The emails the accounts API sends itself: org invites and session invites.
export function inviteEmail ({ orgName, inviterName, roleName, link }) {
  const who = inviterName || 'Someone'
  return {
    subject: `${who} invited you to ${orgName} on Quilt`,
    text: [
      `${who} invited you to join ${orgName} on Quilt as ${roleName}.`,
      '',
      `Accept the invite: ${link}`,
      '',
      'Sign in, or create your account, with this email address. The link works for 7 days.',
      "If you weren't expecting this, you can ignore this email."
    ].join('\n')
  }
}

// Session invites come from a person-to-person address, not the invites@ one.
export const SESSION_INVITE_FROM = 'Quilt <hello@hq.heyquilt.com>'

/** An invite to one session. `link` is the session's join link (it holds the room secret); `site` is heyquilt.com. */
export function sessionInviteEmail ({ inviterName, sessionName, link, site }) {
  const who = inviterName || 'Someone'
  return {
    from: SESSION_INVITE_FROM,
    subject: `${who} invited you to ${sessionName} on Quilt`,
    text: [
      `${who} invited you to ${sessionName}, a live Quilt session where people and their AIs build one project together.`,
      '',
      `Join the session: ${link}`,
      '',
      'This invite expires in 7 days.',
      '',
      `New to Quilt? Download the app from ${site}, sign in with this email address, then open the link again.`,
      "If you weren't expecting this, you can ignore this email."
    ].join('\n')
  }
}
