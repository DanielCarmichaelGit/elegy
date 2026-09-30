import 'server-only'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { apiCall } from './api.js'
import { isSlug } from './space.js'

// Cached per request and keyed on the access token, so a layout and its page share one call.
export const myOrgs = cache(async (accessToken) => {
  const r = await apiCall({ accessToken }, 'GET', '/v1/orgs')
  return r.ok ? r.data.orgs : []
})

/** The viewer's place in an org: { org, role, grants, isOwner, memberId }. Not a member: 404. */
export const orgMe = cache(async (accessToken, slug) => {
  if (!isSlug(slug)) notFound()
  const r = await apiCall({ accessToken }, 'GET', `/v1/orgs/${slug}/me`)
  if (r.status === 404) notFound()
  if (!r.ok) throw new Error(`couldn't load org ${slug} (${r.status})`)
  return r.data
})
