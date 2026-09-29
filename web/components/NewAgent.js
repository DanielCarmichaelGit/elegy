'use client'
import { useActionState, useState } from 'react'
import { createAgent } from '@/app/dashboard/actions.js'
import { agentSetup } from '@/lib/agent-setup.js'

export default function NewAgent () {
  const [state, action, pending] = useActionState(createAgent, null)
  // Done hides the reveal without touching action state, so the key isn't shown again until a fresh create
  const [shown, setShown] = useState(true)
  const [copied, setCopied] = useState(false)

  const copyKey = async () => {
    await navigator.clipboard.writeText(state.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (state?.key && shown) {
    const s = agentSetup(state.key)
    return (
      <div className='stack notice'>
        <b>{state.agent.name} is ready. Copy its key now — it won’t be shown again.</b>
        <code style={{ wordBreak: 'break-all' }}>{state.key}</code>
        <div className='row'>
          <button type='button' className='btn ghost' onClick={copyKey}>{copied ? 'Copied' : 'Copy'}</button>
          <button type='button' className='btn ghost' onClick={() => setShown(false)}>Done</button>
        </div>
        <p className='muted'>Connecting agents to sessions is coming in the next update. When it’s live, add it to Claude Code with:</p>
        <code style={{ wordBreak: 'break-all' }}>{s.claudeCode}</code>
        <p className='muted'>or to Cursor’s MCP settings:</p>
        <pre className='mono' style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{s.cursor}</pre>
      </div>
    )
  }
  return (
    <form action={action} className='row' onSubmit={() => setShown(true)}>
      <input className='input' name='name' placeholder='Agent name, e.g. Larry' maxLength={40} required style={{ flex: '1 1 220px' }} />
      <button className='btn primary' disabled={pending}>{pending ? 'Creating…' : 'Create agent'}</button>
      {state?.error && <p className='notice bad' style={{ flexBasis: '100%' }}>{state.error}</p>}
    </form>
  )
}
