// Required workflow every agent must follow when it picks up a ticket.
// Included in MCP server instructions (local + relay) and in the project
// agent guides written by `quilt setup` (AGENTS.md / CLAUDE.md).

/**
 * One short paragraph: grok → plan → build → test.
 * Keep this the single source of truth so every briefing path says the same thing.
 */
export const TASK_WORKFLOW =
  'When you pick up a ticket (move it to In progress, or start work on one assigned to you): ' +
  'first grok the codebase and workspace (explore the relevant files and how they fit together), ' +
  'then implement a plan, then build the change, then test it (confirm the tests you touch pass) ' +
  'before moving the ticket to Done.'

/** Markdown bullets for AGENTS.md / CLAUDE.md (same steps as TASK_WORKFLOW). */
export const TASK_WORKFLOW_MD =
  '- When you pick up a ticket (move it to In progress, or start work on one assigned to you):\n' +
  '  1. **Grok** the codebase and workspace - explore the relevant files and how they fit together.\n' +
  '  2. **Plan** the change.\n' +
  '  3. **Build** it.\n' +
  '  4. **Test** it and confirm the tests you touch pass before moving the ticket to Done.'

/** Reminder appended when an agent moves a task to In progress. */
export function pickupReminder (title) {
  const who = title ? `"${title}"` : 'this ticket'
  return `Picked up ${who}. ${TASK_WORKFLOW}`
}
