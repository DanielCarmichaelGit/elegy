// How to connect an agent (Claude Code, Cursor, …) to Quilt with its key.
export const MCP_URL = 'https://quilt-api.fly.dev/mcp'

export function agentSetup (key) {
  return {
    claudeCode: `claude mcp add --transport http quilt ${MCP_URL} --header "Authorization: Bearer ${key}"`,
    cursor: JSON.stringify({ mcpServers: { quilt: { url: MCP_URL, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)
  }
}
