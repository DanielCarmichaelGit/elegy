'use client'
import { useRef } from 'react'
import { switchSpace } from '@/app/spaces/actions.js'

// Personal and each org you're in. Changing it switches right away. Orgs are
// only made by signing up as an org, so there's no "create an org" here.
export default function SpaceSwitcher ({ orgs, current }) {
  const form = useRef(null)
  return (
    <form ref={form} action={switchSpace} className='space-switcher'>
      <label className='sr-only' htmlFor='space'>Space</label>
      <select className='input' id='space' name='space' defaultValue={current} onChange={() => form.current.requestSubmit()}>
        <option value='personal'>Personal</option>
        {orgs.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
      </select>
      <noscript><button className='btn'>Go</button></noscript>
    </form>
  )
}
