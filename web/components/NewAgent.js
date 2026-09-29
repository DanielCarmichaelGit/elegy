'use client'
import { useActionState } from 'react'
import { createAgent } from '@/app/dashboard/actions.js'
import { agentSetup } from '@/lib/agent-setup.js'

export default function NewAgent () {
  const [state, action, pending] = useActionState(createAgent, null)
  if (state?.key) {
    const s = agentSetup(state.key)
    return (
      <div className='stack notice'>
        <b>{state.agent.name} is ready. Copy its key now — it won’t be shown again.</b>
        <code style={{ wordBreak: 'break-all' }}>{state.key}</code>
        <p className='muted'>Connecting agents to sessions is coming in the next update. When it’s live, add it to Claude Code with:</p>
        <code style={{ wordBreak: 'break-all' }}>{s.claudeCode}</code>
        <p className='muted'>or to Cursor’s MCP settings:</p>
        <pre className='mono' style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{s.cursor}</pre>
      </div>
    )
  }
  return (
    <form action={action} className='row'>
      <input className='input' name='name' placeholder='Agent name, e.g. Larry' maxLength={40} required style={{ flex: '1 1 220px' }} />
      <button className='btn primary' disabled={pending}>{pending ? 'Creating…' : 'Create agent'}</button>
      {state?.error && <p className='notice bad' style={{ flexBasis: '100%' }}>{state.error}</p>}
    </form>
  )
}
