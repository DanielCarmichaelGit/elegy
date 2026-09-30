'use client'
import { useActionState } from 'react'
import { createOrg } from '@/app/spaces/actions.js'

export default function NewOrgForm () {
  const [state, action, pending] = useActionState(createOrg, null)
  return (
    <form action={action} className='stack'>
      <div className='field'>
        <label htmlFor='name'>Org name</label>
        <input className='input' id='name' name='name' maxLength={80} required placeholder='e.g. Acme' />
      </div>
      <button className='btn primary' disabled={pending}>{pending ? 'Creating...' : 'Create org'}</button>
      {state?.error && <p className='notice bad'>{state.error}</p>}
    </form>
  )
}
