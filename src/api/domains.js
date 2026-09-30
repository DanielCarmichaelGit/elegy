// Public mail providers: anyone can get an address there, so an org can never
// claim one of these domains for join requests.
const PUBLIC = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'mail.com', 'zoho.com', 'zohomail.com', 'fastmail.com', 'fastmail.fm',
  'hey.com', 'qq.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'naver.com', 'daum.net', 'mail.ru', 'inbox.ru', 'list.ru',
  'bk.ru', 'rambler.ru', 'web.de', 't-online.de', 'tutanota.com', 'tuta.io', 'hushmail.com', 'rediffmail.com', 'ymail.com',
  'rocketmail.com', 'outlook.co.uk', 'hotmail.co.uk', 'live.co.uk', 'duck.com', 'mailbox.org', 'posteo.de'
])
// Providers with a domain per country: yahoo.co.uk, gmx.de, yandex.ru, ...
const FAMILIES = /^(yahoo|gmx|yandex)\.[a-z]{2,}(\.[a-z]{2,})?$/
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function isDomain (d) {
  return DOMAIN.test(String(d || ''))
}

/** The lowercase domain of an email address, or '' if it doesn't have a real one. */
export function emailDomain (email) {
  const s = String(email || '').trim().toLowerCase()
  const at = s.lastIndexOf('@')
  if (at < 1) return ''
  const d = s.slice(at + 1).replace(/\.$/, '')
  return isDomain(d) ? d : ''
}

export function isPublicDomain (domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '')
  return PUBLIC.has(d) || FAMILIES.test(d)
}
