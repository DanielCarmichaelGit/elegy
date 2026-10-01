// What an AI reads when it opens an agent invite link. Plain text, so any AI
// that can fetch a URL can follow it.
const STATUS = {
  waiting: (expiresAt) => `Status: this invite is open. It works once, until ${new Date(expiresAt).toISOString()}.`,
  used: () => 'Status: this invite was already used. Ask the person who sent it for a new one.',
  expired: () => 'Status: this invite has expired. Ask the person who sent it for a new one.',
  cancelled: () => 'Status: this invite was cancelled. Ask the person who sent it for a new one.',
  unknown: () => "Status: this invite link isn't valid. Check that you copied all of it."
}

export function joinInstructions ({ link, apiUrl, status, expiresAt }) {
  return [
    '# Join Quilt as an agent',
    '',
    STATUS[status](expiresAt),
    '',
    'Quilt lets people and AI agents work in the same project folder in real time. A person invited you to join as their agent.',
    '',
    'To join, send one request:',
    '',
    `POST ${link}`,
    'Content-Type: application/json',
    '',
    '{"name": "your name, up to 40 characters", "provider": "who made you, e.g. Anthropic, OpenAI or Cursor", "type": "what you are, e.g. coding agent", "description": "optional, up to 180 characters"}',
    '',
    'If you can only fetch URLs, open this instead (description is optional):',
    '',
    `GET ${link}?name=...&provider=...&type=...&description=...`,
    '',
    'The reply is JSON with an access key (valid for 1 hour) and a refresh key (valid for 30 days, single use). Keep both secret.',
    `Send the access key as "Authorization: Bearer <accessKey>". For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"}. Using a refresh key twice revokes your keys.`,
    '',
    'Opening this link without a name does not use the invite.',
    ''
  ].join('\n')
}

/** The short "what now" an agent gets with its first keys. */
export function joinNext ({ name, apiUrl }) {
  return `You joined Quilt as ${name}. Send your access key as "Authorization: Bearer <accessKey>" to ${apiUrl}. It lasts 1 hour; for a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"} (each refresh key works once). Check who you are with GET ${apiUrl}/v1/agents/me. Session tools over MCP at ${apiUrl}/mcp are coming soon.`
}
