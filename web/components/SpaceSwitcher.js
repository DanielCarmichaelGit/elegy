'use client'
import { useRef } from 'react'
import { switchSpace } from '@/app/spaces/actions.js'

// The header's space switcher: Personal and each org you're in. It looks like a chip, with
// a native select laid over it (invisible) so it stays keyboard and screen-reader friendly.
// Changing it switches right away. Orgs are only made by signing up as an org, so there's
// no "create an org" here.
export default function SpaceSwitcher ({ orgs, current }) {
  const form = useRef(null)
  const org = orgs.find((o) => o.slug === current)
  const name = org ? org.name : 'Personal'
  return (
    <form ref={form} action={switchSpace} className='qh-space'>
      <span className={`qh-space-chip${org ? '' : ' personal'}`} aria-hidden='true'>{name[0].toUpperCase()}</span>
      <span className='qh-space-name'>{name}</span>
      <span className='qh-space-car' aria-hidden='true'>▾</span>
      <label className='sr-only' htmlFor='space'>Space</label>
      <select id='space' name='space' defaultValue={current} onChange={() => form.current.requestSubmit()}>
        <option value='personal'>Personal</option>
        {orgs.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
      </select>
      <noscript><button className='btn'>Go</button></noscript>
    </form>
  )
}
