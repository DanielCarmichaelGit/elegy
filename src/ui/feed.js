// A person's AI conversation, read-only: their prompts, the AI's replies and
// one-line actions ("Edited src/app.ts"), with dividers between conversations.
import { esc, clock, avatar, I } from './common.js'

/**
 * Renders the feed into `el` (the scrolling main area). Keeps the reader's
 * scroll position unless they were already at the bottom.
 */
export function renderFeed (el, { entries, person, isMe, color, agent, online }) {
  const scroller = el.querySelector('.feed-scroll')
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
  const prevCount = scroller ? Number(scroller.dataset.count || 0) : 0
  const prevTop = scroller ? scroller.scrollTop : 0

  const who = isMe ? 'You' : person
  const whose = isMe ? 'your' : `${person}'s`
  const sharing = !agent || agent.sharing !== false
  const working = sharing && agent && agent.status === 'working'
  let body

  if (!entries.length) {
    let title, hint
    if (!sharing) {
      title = isMe ? 'You paused sharing your AI chat' : `${person} paused sharing`
      hint = isMe ? 'Resume from the people menu when you want partners to follow along.' : 'Their AI conversation shows up here when they resume.'
    } else if (agent && agent.status === 'unavailable') {
      title = `${isMe ? 'Your' : `${person}'s`} ${agent.tool || 'AI'} feed isn't available`
      hint = agent.reason || ''
    } else if (isMe) {
      title = 'Nothing from your AI yet'
      hint = 'When you chat with Claude Code or Cursor in this folder, the conversation shows up here for your partners. Actions are shown as one line; command output and file contents never leave your machine.'
    } else {
      title = `No AI activity from ${person} yet`
      hint = online ? `When ${person} chats with Claude Code or Cursor, you'll see it here live.` : `${person} is offline right now.`
    }
    body = `<div class="feed-empty">${avatar(person, color, online)}<div class="t">${esc(title)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`
  } else {
    const parts = []
    let conv = null
    let actions = []
    const flush = () => {
      if (!actions.length) return
      parts.push(`<div class="f-actions">${actions.map((a) => `<div class="f-action"><span class="chev">›</span><span>${esc(a.text)}</span></div>`).join('')}</div>`)
      actions = []
    }
    for (const e of entries) {
      if (e.kind === 'paused' || e.kind === 'resumed') {
        flush()
        parts.push(`<div class="feed-divider"><span>${esc(who)} ${e.kind === 'paused' ? 'paused' : 'resumed'} sharing · ${esc(clock(e.ts))}</span></div>`)
        continue
      }
      if (e.conv && conv && e.conv !== conv) {
        flush()
        parts.push(`<div class="feed-divider"><span>New conversation${e.tool ? ` · ${esc(e.tool)}` : ''}</span></div>`)
      }
      if (e.conv) conv = e.conv
      if (e.kind === 'action') { actions.push(e); continue }
      flush()
      if (e.kind === 'prompt') {
        parts.push(`<div class="f-prompt">${avatar(person, color)}<div class="f-body">
          <div class="head"><b>${esc(who)}</b><span>${esc(clock(e.ts))}</span>${e.summary ? '<span class="tag summary" title="Summarized before sharing">summary</span>' : ''}</div>
          <div class="bubble"><div class="text">${esc(e.text)}</div></div></div></div>`)
      } else if (e.kind === 'reply') {
        parts.push(`<div class="f-reply"><div class="head"><span class="ai-badge">${I.sparkle}${esc(e.tool || 'AI')}</span><span>${esc(clock(e.ts))}</span>${e.summary ? '<span class="tag summary" title="Summarized before sharing">summary</span>' : ''}</div>
          <div class="md">${markdown(e.text)}</div></div>`)
      }
    }
    flush()
    if (!sharing) parts.push(`<div class="feed-note">${esc(isMe ? 'You paused sharing' : `${person} paused sharing`)}</div>`)
    body = parts.join('')
  }

  const workingHtml = working
    ? `<div class="f-working"><span class="dots"><i></i><i></i><i></i></span>${esc(isMe ? 'Your AI is working…' : `${whose} AI is working…`)}</div>`
    : ''

  el.innerHTML = `<div class="feed-scroll" data-count="${entries.length}"><div class="feed">${body}${workingHtml}</div></div>
    <button class="btn sm new-activity" hidden>${I.down}<span>New activity</span></button>`
  const s = el.querySelector('.feed-scroll')
  const jump = el.querySelector('.new-activity')
  if (atBottom || !scroller) s.scrollTop = s.scrollHeight
  else {
    s.scrollTop = prevTop
    if (entries.length > prevCount) jump.hidden = false
  }
  jump.onclick = () => { s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' }); jump.hidden = true }
  s.addEventListener('scroll', () => { if (s.scrollHeight - s.scrollTop - s.clientHeight < 60) jump.hidden = true })
}

// ------------------------------------------------------------ markdown --
// Just enough Markdown for AI replies: code blocks, inline code, bold,
// italics, headings, lists and links. Everything is escaped first.

export function markdown (text) {
  const out = []
  const chunks = String(text).split(/^```/m)
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const nl = chunk.indexOf('\n')
      const code = nl === -1 ? '' : chunk.slice(nl + 1)
      out.push(`<pre class="md-code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`)
    } else {
      out.push(blocks(chunk))
    }
  })
  return out.join('')
}

function blocks (text) {
  const lines = text.split('\n')
  const out = []
  let para = []
  let list = null
  const endPara = () => { if (para.length) { out.push(`<p>${inline(para.join('\n'))}</p>`); para = [] } }
  const endList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null } }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/)
    const head = line.match(/^(#{1,6})\s+(.*)$/)
    if (!line.trim()) { endPara(); endList(); continue }
    if (head) { endPara(); endList(); out.push(`<p class="md-h">${inline(head[2])}</p>`); continue }
    if (bullet || num) {
      endPara()
      const tag = bullet ? 'ul' : 'ol'
      if (list && list.tag !== tag) endList()
      if (!list) list = { tag, items: [] }
      list.items.push((bullet || num)[1])
      continue
    }
    if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue }
    endList()
    para.push(line)
  }
  endPara()
  endList()
  return out.join('')
}

function inline (text) {
  return String(text).split('`').map((part, i) => {
    if (i % 2 === 1) return `<code>${esc(part)}</code>`
    let s = esc(part)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    return s.replace(/\n/g, '<br>')
  }).join('')
}
