// How the accounts API sends email (org invites). Production uses SMTP, e.g.
// SMTP_URL=smtp://resend:<key>@smtp.resend.com:587 and SMTP_FROM="Quilt <invites@heyquilt.com>".
import nodemailer from 'nodemailer'

export function createSmtpMailer ({ url, from, transport }) {
  const t = transport || nodemailer.createTransport(url)
  return { send: ({ to, subject, text }) => t.sendMail({ from, to, subject, text }) }
}

// `quilt api --memory` prints emails instead, so invite links can be copied from the terminal.
export function createConsoleMailer (log = console.log) {
  return { send: async ({ to, subject, text }) => { log(`--- email to ${to}: ${subject}\n${text}\n---`) } }
}
