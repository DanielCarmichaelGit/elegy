import { AppHeaderSkeleton } from '@/components/AppHeader.js'

// The org layout does its own data fetching (org info, member role, tabs), so this covers
// both the layout and the page while that loads. Includes the Header so nothing shifts.
export default function Loading () {
  return (
    <>
      <AppHeaderSkeleton />
      <main className='wrap page stack'>
        <div className='skeleton skeleton-title' />
        <div className='card skeleton-card' />
        <div className='card skeleton-card' />
      </main>
    </>
  )
}
