# Pricing

**Status:** Direction agreed (2026-09-28), not built.

## Plans

- **Free:** everything that runs locally. Start and join sessions on a relay
  you run yourself (on your computer or your network), sync, chat, the AI
  feed, claims, agents that run on your machine.
- **Paid (individual):** cloud-based sessions: the hosted relay, so people
  can join from anywhere without running anything, and cloud agents joining
  sessions.
- **Org subscription, per seat:** for teams. Orgs get more control over who
  can reach their sessions, and so on.

## What it needs

- **Accounts.** People sign in on the cowove website (the website is for
  sign-in and accounts; the app itself is the desktop app). Today a person is
  a key kept on their computer (`~/.cowove/identity.json`); an account would
  own that key, so the same person is recognized on every computer and
  nobody can use their name.
- **The hosted relay checks the plan.** Today it takes one shared relay key
  (`COWOVE_RELAY_KEY`). Instead, starting a cloud session would need a
  signed-in account on a paid plan (or an org seat); joining someone's
  session by invite link would stay free.
- **Orgs.** Members, seats and billing, and org-level rules on top of the
  per-session approvals that exist now (roles, folder limits for agents):
  for example, only org members can join, or an org owns every session its
  members start.

## Open questions

- Does joining a paid person's cloud session need a paid plan too, or only
  starting one?
- Where agents fit: do cloud agents count as seats in an org?
- Billing provider, and prices.
