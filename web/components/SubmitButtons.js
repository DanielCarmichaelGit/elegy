'use client'
import { useFormStatus } from 'react-dom'

export default function SubmitButtons () {
  const { pending } = useFormStatus()
  return (
    <>
      <button className='btn primary' name='decision' value='approve' disabled={pending}>Approve</button>
      <button className='btn ghost' name='decision' value='deny' disabled={pending}>Deny</button>
    </>
  )
}
