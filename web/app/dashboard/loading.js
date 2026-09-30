import { AppHeaderSkeleton } from '@/components/AppHeader.js'

// Shown instantly on navigation while the dashboard's data loads. Includes the Header so
// nothing shifts when the real page swaps in.
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
