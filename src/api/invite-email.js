// The one email the accounts API sends itself: an org invite.
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
