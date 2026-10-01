// Reading the agent invite form. Pure, so it's unit-tested directly.

/** "src, docs/ ,web" to ['src', 'docs/', 'web']: the API tidies each folder. */
export function splitFolders (s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
}

/** The role and teams an org invite hands out. Rows without a team are skipped. */
export function inviteFromForm (formData) {
  const access = formData.getAll('access').map(String)
  const folders = formData.getAll('folders').map(String)
  const teams = formData.getAll('teamId').map(String)
    .map((teamId, i) => ({ teamId, access: access[i] === 'editor' ? 'editor' : 'viewer', scopes: splitFolders(folders[i]) }))
    .filter((t) => t.teamId)
  return { roleId: String(formData.get('roleId') || '') || null, teams }
}
