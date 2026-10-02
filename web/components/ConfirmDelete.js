'use client'
import { useState } from 'react'

// Delete, then a second, in-page step: "Delete it" or "Keep it". `action` is the server
// action the confirming button submits the surrounding form to.
export default function ConfirmDelete ({ action, what, note }) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <button type='button' className='btn ghost danger' onClick={() => setAsking(true)}>Delete</button>
  return (
    <span className='row' role='group' aria-label={`Delete ${what}?`}>
      <span className='muted'>Delete {what}?{note ? ` ${note}` : ''}</span>
      <button className='btn danger' formAction={action}>Delete it</button>
      <button type='button' className='btn ghost' onClick={() => setAsking(false)}>Keep it</button>
    </span>
  )
}
