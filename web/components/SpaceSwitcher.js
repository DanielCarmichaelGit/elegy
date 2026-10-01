'use client'

// The header's space switcher: Personal and each org you're in, as a button that opens a
// listbox in the site's own look. Choosing one submits switchSpace right away. Keyboard:
// Enter, Space or the arrows open it; arrows, Home and End move; Enter or Space choose;
// Escape or Tab close. A click outside closes it too. Without JavaScript a plain form with a
// native select takes its place. Orgs are only made by signing up as an org, so there's no
// "create an org" here.
import { useEffect, useId, useRef, useState } from 'react'
import { switchSpace } from '@/app/spaces/actions.js'
import { moveIndex } from '@/lib/listbox.js'

function Chip ({ name, personal }) {
  return <span className={`qh-space-chip${personal ? ' personal' : ''}`} aria-hidden='true'>{name[0].toUpperCase()}</span>
}

export default function SpaceSwitcher ({ orgs, current }) {
  const options = [{ slug: 'personal', name: 'Personal' }, ...orgs.map((o) => ({ slug: o.slug, name: o.name }))]
  const selected = Math.max(0, options.findIndex((o) => o.slug === current))
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(selected)
  const [pending, setPending] = useState(false)
  const root = useRef(null)
  const button = useRef(null)
  const list = useRef(null)
  const form = useRef(null)
  const value = useRef(null)
  const id = useId()
  const listId = `${id}-list`
  const optionId = (i) => `${id}-opt-${i}`

  useEffect(() => {
    if (!open) return
    list.current?.focus()
    const onClick = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Keep the active option in view when the list is long.
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  })

  const show = (at = selected) => { setActive(at); setOpen(true) }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  const choose = (i) => {
    close()
    if (i === selected) return
    value.current.value = options[i].slug
    setPending(true)
    form.current.requestSubmit()
  }

  const onButtonKey = (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      show(e.key === 'ArrowUp' ? Math.max(selected - 1, 0) : selected)
    }
  }
  const onListKey = (e) => {
    const to = moveIndex(e.key, active, options.length)
    if (to !== null) {
      e.preventDefault()
      setActive(to)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      choose(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  const here = options[selected]
  return (
    <div className='qh-space' ref={root}>
      <noscript>
        <style>{'.qh-space-js { display: none !important; }'}</style>
        <form action={switchSpace} className='qh-space-plain'>
          <label className='sr-only' htmlFor={`${id}-select`}>Space</label>
          <select className='input' id={`${id}-select`} name='space' defaultValue={here.slug}>
            {options.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
          </select>
          <button className='btn'>Go</button>
        </form>
      </noscript>
      <form ref={form} action={switchSpace} className='qh-space-js'>
        <input ref={value} type='hidden' name='space' defaultValue={here.slug} />
        <button
          ref={button}
          type='button'
          className='qh-space-btn'
          aria-haspopup='listbox'
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`Space: ${here.name}`}
          aria-busy={pending || undefined}
          onClick={() => (open ? close() : show())}
          onKeyDown={onButtonKey}
        >
          <Chip name={here.name} personal={here.slug === 'personal'} />
          <span className='qh-space-name'>{here.name}</span>
          <span className='qh-space-car' aria-hidden='true'><svg viewBox='0 0 12 12' width='10' height='10' aria-hidden='true'><path d='M2.5 4.5h7L6 8.5z' fill='currentColor' /></svg></span>
        </button>
        {open && (
          <ul
            ref={list}
            id={listId}
            className='qh-space-menu'
            role='listbox'
            aria-label='Spaces'
            tabIndex={-1}
            aria-activedescendant={optionId(active)}
            onKeyDown={onListKey}
          >
            {options.map((o, i) => (
              <li
                key={o.slug}
                id={optionId(i)}
                role='option'
                aria-selected={i === selected}
                className={`qh-space-opt${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
              >
                <Chip name={o.name} personal={o.slug === 'personal'} />
                <span className='qh-space-opt-name'>{o.name}</span>
                {i === selected && (
                  <svg className='qh-space-check' viewBox='0 0 16 16' aria-hidden='true'>
                    <path d='M3 8.5l3 3 7-7' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                  </svg>
                )}
              </li>
            ))}
          </ul>
        )}
      </form>
    </div>
  )
}
