'use client'

// The Monthly/Yearly toggle and the three plan cards. Client-only because the prices react
// to the toggle; the rest of the pricing page (comparison table, FAQ) stays static server markup.
import { useState } from 'react'
import Link from 'next/link'
import { PLANS, yearlyMonthly } from '@/lib/pricing.js'

function Check () {
  return (
    <span className='ck' aria-label='Included'>
      <svg viewBox='0 0 16 16' aria-hidden='true'>
        <path d='M3 8.5l3 3 7-7' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
      </svg>
    </span>
  )
}

export default function PricingPlans () {
  const [yearly, setYearly] = useState(false)

  return (
    <>
      <div className='pr-toggle' role='group' aria-label='Billing period'>
        <div className='pr-toggle-track'>
          <button type='button' className={`pr-toggle-opt${!yearly ? ' on' : ''}`} aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button>
          <button type='button' className={`pr-toggle-opt${yearly ? ' on' : ''}`} aria-pressed={yearly} onClick={() => setYearly(true)}>
            Yearly <em>save ~20%</em>
          </button>
        </div>
      </div>

      <div className='plans'>
        {PLANS.map((plan) => {
          const price = yearly ? yearlyMonthly(plan.monthly) : plan.monthly
          const unit = plan.monthly === 0 ? plan.unit : yearly ? 'per month, billed yearly' : plan.unit
          return (
            <div key={plan.id} className={`plan${plan.popular ? ' pop' : ''}`}>
              {plan.popular && <span className='badge'>Most popular</span>}
              <h3>{plan.name}</h3>
              <p className='who'>{plan.who}</p>
              <div className='price'><b>${price}</b><span>{unit}</span></div>
              <ul>
                {plan.features.map((f) => <li key={f}><Check />{f}</li>)}
              </ul>
              <Link className={`btn ${plan.cta.primary ? 'primary' : ''}`} href={plan.cta.href}>{plan.cta.label}</Link>
            </div>
          )
        })}
      </div>
    </>
  )
}
