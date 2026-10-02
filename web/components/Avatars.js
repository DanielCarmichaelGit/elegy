import { avatarList, initialsOf } from '@/lib/activity-view.js'

// Faces for the people and agents in a session (at most `max`, then "+N"). Agents wear the agent badge.
export default function Avatars ({ people, max }) {
  const { shown, more } = avatarList(people, max)
  return (
    <span className='avatars'>
      {shown.map((p) => (
        <span key={p.account} className={`avatar${p.kind === 'agent' ? ' agent' : ''}`} title={p.kind === 'agent' ? `${p.name} (agent)` : p.name}>
          <span aria-hidden='true'>{initialsOf(p.name)}</span>
          <span className='sr-only'>{p.kind === 'agent' ? `${p.name} (agent)` : p.name}</span>
          {p.kind === 'agent' && (
            <span className='avatar-badge' aria-hidden='true'>
              <svg viewBox='0 0 12 12' width='9' height='9'><rect x='2' y='3.5' width='8' height='6' rx='1.5' fill='none' stroke='currentColor' strokeWidth='1.3' /><path d='M6 1.5v2' stroke='currentColor' strokeWidth='1.3' /><circle cx='4.5' cy='6.5' r='.8' fill='currentColor' /><circle cx='7.5' cy='6.5' r='.8' fill='currentColor' /></svg>
            </span>)}
        </span>))}
      {more > 0 && <span className='avatar more'>+{more}</span>}
    </span>
  )
}
