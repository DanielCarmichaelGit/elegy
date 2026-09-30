// Plan and comparison-table data for the pricing page, kept in one place so it's easy to edit.
// Prices are placeholders while Quilt is being built.

export const PLANS = [
  {
    id: 'free',
    name: 'Free',
    who: 'For building together on the same network.',
    monthly: 0,
    unit: 'forever',
    features: [
      'Unlimited local sessions',
      'Live sync, chat and the AI feed',
      'Agents on your own computer'
    ],
    cta: { label: 'Download', href: '/#download' }
  },
  {
    id: 'pro',
    name: 'Pro',
    who: 'For working with anyone, anywhere.',
    popular: true,
    monthly: 12,
    unit: 'per month',
    features: [
      'Everything in Free',
      'Hosted sessions: join from anywhere',
      'Cloud agents that join sessions'
    ],
    cta: { label: 'Start Pro', href: '/signup', primary: true }
  },
  {
    id: 'team',
    name: 'Team',
    who: 'For companies with people and agents.',
    monthly: 10,
    unit: 'per seat / month',
    features: [
      'Everything in Pro',
      'Orgs, teams and custom roles',
      'Invite by email or company domain'
    ],
    cta: { label: 'Start a team', href: '/signup/org' }
  }
]

// The yearly-equivalent monthly price shown when the toggle is set to Yearly: about 20% off.
export function yearlyMonthly (monthly) {
  return monthly === 0 ? 0 : Math.round(monthly * 0.8)
}

export const COMPARISON = [
  {
    group: 'Sessions',
    rows: [
      ['Sync a project folder live', true, true, true],
      ['Chat and the live AI feed', true, true, true],
      ['Claims, so two AIs never edit the same file', true, true, true],
      ['Sessions on your own network', true, true, true],
      ['Hosted sessions: join from anywhere', false, true, true]
    ]
  },
  {
    group: 'Agents',
    rows: [
      ['Agents that run on your computer', true, true, true],
      ['Cloud agents that join sessions', false, true, true]
    ]
  },
  {
    group: 'Teams',
    rows: [
      ['Orgs, teams and custom roles', false, false, true],
      ['Invite by email or company domain', false, false, true],
      ['Team sessions: members get in automatically', false, false, true],
      ['Admin controls for people and agents', false, false, true]
    ]
  }
]

export const FAQ = [
  { q: 'Do my partners need to pay?', a: 'Joining a session by invite link stays free. Only starting hosted sessions needs Pro.' },
  { q: 'Do agents count as seats?', a: 'Not yet decided. Agents are free while we build it.' }
]
