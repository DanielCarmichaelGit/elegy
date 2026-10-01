'use client'
import { useFormStatus } from 'react-dom'

export default function SubmitButtons () {
  const { pending, data } = useFormStatus()
  const choice = pending ? data?.get('decision') : null
  return (
    <>
      <button className='btn primary' name='decision' value='approve' disabled={pending}>{choice === 'approve' ? 'Approving…' : 'Approve'}</button>
      <button className='btn ghost' name='decision' value='deny' disabled={pending}>{choice === 'deny' ? 'Denying…' : 'Deny'}</button>
    </>
  )
}
