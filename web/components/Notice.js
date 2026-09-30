import { safeMessage } from '@/lib/org-view.js'

// "Saved." after a form went through, or the reason it didn't.
export default function Notice ({ q }) {
  if (q?.saved) return <p className='notice'>Saved.</p>
  const e = safeMessage(q?.error)
  return e ? <p className='notice bad'>{e}</p> : null
}
