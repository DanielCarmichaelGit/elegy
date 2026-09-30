import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSmtpMailer, createConsoleMailer } from '../src/api/mailer.js'

test('the SMTP mailer sends from SMTP_FROM with the message it is given', async () => {
  const sent = []
  const m = createSmtpMailer({ from: 'Quilt <invites@heyquilt.com>', transport: { sendMail: async (x) => { sent.push(x) } } })
  await m.send({ to: 'a@acme.com', subject: 'Hi', text: 'Body' })
  assert.deepEqual(sent, [{ from: 'Quilt <invites@heyquilt.com>', to: 'a@acme.com', subject: 'Hi', text: 'Body' }])
})

test('the SMTP mailer builds its transport from SMTP_URL without connecting', () => {
  const m = createSmtpMailer({ url: 'smtp://user:pass@127.0.0.1:2525', from: 'x@quilt.test' })
  assert.equal(typeof m.send, 'function')
})

test('the console mailer prints the email, link included', async () => {
  const lines = []
  await createConsoleMailer((l) => lines.push(l)).send({ to: 'a@acme.com', subject: 'Hi', text: 'Open http://localhost:3000/invite/qi_x' })
  assert.match(lines.join('\n'), /a@acme\.com[\s\S]*qi_x/)
})
