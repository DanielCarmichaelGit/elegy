'use client'
import { useActionState, useEffect, useState } from 'react'
import Link from 'next/link'
import { sessionTitle } from '@/lib/activity-view.js'

/** A session's name. Its owner gets a pencil that renames it in place, for everyone. */
export default function SessionName ({ room, name, canRename, action, href }) {
  const [editing, setEditing] = useState(false)
  const [state, formAction, pending] = useActionState(action, null)
  const current = state?.name ?? name
  // A successful rename closes the form; an error keeps it open, with the message.
  useEffect(() => { if (state?.name) setEditing(false) }, [state])
  if (editing) {
    return (
      <form action={formAction} className='rename-form'>
        <input type='hidden' name='room' value={room} />
        <input className='input' name='name' defaultValue={current} maxLength={80} required aria-label='Session name' autoFocus />
        <button className='btn' disabled={pending}>Save</button>
        <button type='button' className='btn ghost' onClick={() => setEditing(false)}>Cancel</button>
        {state?.error && <span className='notice bad'>{state.error}</span>}
      </form>
    )
  }
  const title = sessionTitle(current)
  return (
    <span className='session-name'>
      {href ? <Link href={href}>{title}</Link> : <span>{title}</span>}
      {canRename && (
        <button type='button' className='btn ghost icon-btn' onClick={() => setEditing(true)} aria-label={`Rename ${title}`} title='Rename'>
          <svg viewBox='0 0 16 16' width='14' height='14' aria-hidden='true'><path d='M11.5 2.5l2 2L6 12l-3 1 1-3z' fill='none' stroke='currentColor' strokeWidth='1.5' strokeLinejoin='round' /></svg>
        </button>)}
    </span>
  )
}
