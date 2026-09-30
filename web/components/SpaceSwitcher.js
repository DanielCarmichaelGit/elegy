'use client'
import { useRef } from 'react'
import { switchSpace } from '@/app/spaces/actions.js'

// Personal, each org you're in, and "Create an org". Changing it switches right away.
export default function SpaceSwitcher ({ orgs, current }) {
  const form = useRef(null)
  return (
    <form ref={form} action={switchSpace} className='space-switcher'>
      <label className='sr-only' htmlFor='space'>Space</label>
      <select className='input' id='space' name='space' defaultValue={current} onChange={() => form.current.requestSubmit()}>
        <option value='personal'>Personal</option>
        {orgs.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
        <option value='+new'>Create an org...</option>
      </select>
      <noscript><button className='btn'>Go</button></noscript>
    </form>
  )
}
