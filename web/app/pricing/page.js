import { Fragment } from 'react'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import PricingPlans from '@/components/PricingPlans.js'
import { COMPARISON, FAQ } from '@/lib/pricing.js'

// Fully static: no headers()/cookies()/currentUser, so this prerenders at build time.
export const metadata = { title: 'Pricing' }

function Check () {
  return (
    <span className='ck' aria-label='Included'>
      <svg viewBox='0 0 16 16' aria-hidden='true'>
        <path d='M3 8.5l3 3 7-7' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
      </svg>
    </span>
  )
}

const NotIncluded = () => <span className='no' aria-label='Not included'>-</span>

export default function Pricing () {
  return (
    <>
      <Header />
      <main className='wrap page pr'>
        <h1>Simple pricing</h1>
        <p className='sub'>Free for everything on your own network. Pay when you want Quilt to host it.</p>
        <p className='temp'><span>Placeholder prices while we build it</span></p>

        <PricingPlans />

        <div className='cmp'>
          <div className='table-scroll'>
            <table>
              <thead>
                <tr>
                  <th>Compare plans</th>
                  <th>Free</th>
                  <th className='popcol'>Pro</th>
                  <th>Team</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((section) => (
                  <Fragment key={section.group}>
                    <tr className='grp'><th colSpan={4}>{section.group}</th></tr>
                    {section.rows.map(([label, free, pro, team]) => (
                      <tr key={label}>
                        <th scope='row'>{label}</th>
                        <td>{free ? <Check /> : <NotIncluded />}</td>
                        <td className='popcol'>{pro ? <Check /> : <NotIncluded />}</td>
                        <td>{team ? <Check /> : <NotIncluded />}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className='faq'>
          {FAQ.map((item) => (
            <div key={item.q} className='card'>
              <h4>{item.q}</h4>
              <p className='muted'>{item.a}</p>
            </div>
          ))}
        </div>
      </main>
      <Footer />
    </>
  )
}
