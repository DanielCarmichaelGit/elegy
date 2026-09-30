// How the accounts API sends email (org invites). Production uses SMTP, e.g.
// SMTP_URL=smtp://resend:<key>@smtp.resend.com:587 and SMTP_FROM="Quilt <invites@heyquilt.com>".
import nodemailer from 'nodemailer'

// Parses SMTP_URL into nodemailer transport options ourselves, rather than handing
// the raw string to nodemailer.createTransport, so smtp:// always requires TLS.
// Without requireTLS, smtp:// (port 587) only offers opportunistic STARTTLS: a
// network attacker who strips the STARTTLS response from the server's reply can
// make nodemailer fall back to authenticating in the clear. smtps:// is already
// always-TLS via `secure`. The error for a bad URL never includes the password.
function parseSmtpUrl (raw) {
  let u
  try {
    u = new URL(raw || '')
  } catch {
    throw new Error('SMTP_URL is not a valid URL')
  }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') {
    throw new Error('SMTP_URL must start with smtp:// or smtps://')
  }
  const secure = u.protocol === 'smtps:'
  const options = { host: u.hostname, port: u.port ? Number(u.port) : (secure ? 465 : 587), secure }
  if (u.username || u.password) {
    options.auth = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }
  }
  if (!secure) options.requireTLS = true
  return options
}

export function createSmtpMailer ({ url, from, transport, createTransport = nodemailer.createTransport }) {
  const t = transport || createTransport(parseSmtpUrl(url))
  return { send: ({ to, subject, text }) => t.sendMail({ from, to, subject, text }) }
}

// `quilt api --memory` prints emails instead, so invite links can be copied from the terminal.
export function createConsoleMailer (log = console.log) {
  return { send: async ({ to, subject, text }) => { log(`--- email to ${to}: ${subject}\n${text}\n---`) } }
}
