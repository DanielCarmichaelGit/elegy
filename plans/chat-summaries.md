# Summaries of other people's AI chats

**Status: benched.** Needs an LLM API key, which isn't wired up yet. Kept here
so the design is ready when it is.

## Problem

The feed shows a partner's AI conversation verbatim. Long replies and dozens
of actions are too much to follow while you're working. You want "what are
they doing?" in a line or two.

## Shape

- Summarize **other people's** feeds only, never your own.
- Two levels:
  - **Turn summary**: after each of their prompts settles (their AI goes idle,
    or the next prompt arrives), one short line, e.g. *"Sam: made the header
    sticky and blue; edited header.css, ran tests (passing)."*
  - **Catch-up**: a button, "What happened while I was away?", that condenses
    everything since you last looked into 3–5 bullets.
- The raw feed stays one click away ("show full conversation").
- Short and sweet: hard cap of ~200 characters per turn summary; no preamble.

## Where it runs

- **On the viewer's machine**, in the local daemon, with the viewer's own key.
  Nothing new leaves anyone's machine beyond what the feed already shares,
  and no shared key is needed. Summaries are cached locally by turn id.
- Later, optionally on the hosted service (paid tier), so browser-only viewers
  get summaries too.

## Implementation notes

- Input per turn: the prompt, the reply text (already capped at 8000 chars
  per entry), and the one-line actions. Actions are already safe to share
  (no file contents, no command arguments).
- Model: a small, fast model (e.g. Claude Haiku) is enough; batch a turn into
  one request. Use prompt caching for the fixed instructions.
- Turn boundaries: a `prompt` entry starts a turn; the turn ends at the next
  `prompt` or when the partner's agent state goes `idle`.
- Config: `elegy summaries on --key <ANTHROPIC_API_KEY>` or the `ANTHROPIC_API_KEY`
  environment variable; off by default. The UI shows a toggle when a key is set.
- Fallback without a key: a cheap heuristic summary (first sentence of the
  prompt + counts of edited files and commands), so the UI can ship the
  "compact view" before the LLM part.

## Open questions

- Should agents get summaries via MCP too (`elegy_partner_feed` with
  `summary: true`)? Probably yes; it saves them tokens.
- Per-person opt-out of being summarized?
